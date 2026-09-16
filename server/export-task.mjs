import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { probeMedia } from './media-probe.mjs';
import {
  createMediaAsset,
  getExportTask,
  getProject,
  listExportTasks,
  listMediaAssets,
  listSegments,
  timestamp,
  updateExportTask,
  updateProject,
} from './db.mjs';

const doneStates = new Set(['succeeded', 'failed', 'canceled']);

export class ExportTaskRunner {
  constructor({ db, mediaRoot = './data/media', ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', logger = console, stepDelayMs = 220 }) {
    this.db = db;
    this.mediaRoot = resolve(mediaRoot);
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.logger = logger;
    this.stepDelayMs = Math.max(0, stepDelayMs);
    this.queued = new Set();
  }

  enqueue(taskId) {
    if (this.queued.has(taskId)) return;
    this.queued.add(taskId);
    queueMicrotask(async () => {
      try { await this.run(taskId); }
      finally { this.queued.delete(taskId); }
    });
  }

  async run(taskId) {
    const task = getExportTask(this.db, taskId);
    if (!task || doneStates.has(task.status)) return;
    const project = getProject(this.db, task.project_id);
    if (!project) return this.fail(task, 'PROJECT_NOT_FOUND', '作品不存在');
    const segmentVersionId = project.active_script_version_id;
    const segments = segmentVersionId ? listSegments(this.db, segmentVersionId) : [];
    const assets = listMediaAssets(this.db, { projectId: project.id });
    const readySegments = segments.map(segment => {
      if (!segment.active_version_id) return null;
      const asset = assets.find(item => item.segment_version_id === segment.active_version_id && item.type === 'video' && item.status === 'ready');
      return asset ? { ...segment, objectKey: asset.object_key } : null;
    }).filter(Boolean);
    if (!segments.length || readySegments.length !== segments.length) {
      return this.fail(task, 'EXPORT_ASSETS_NOT_READY', '仍有片段没有可用视频素材');
    }

    updateProject(this.db, project.id, { status: 'exporting', updated_at: timestamp() });
    updateExportTask(this.db, task.id, { status: 'running', progress: 12, updated_at: timestamp() });
    const objectKey = `projects/${safe(project.id)}/exports/${safe(task.id)}.mp4`;
    const output = resolve(this.mediaRoot, objectKey);
    await mkdir(dirname(output), { recursive: true });
    await this.concatSegments({ output, segments: readySegments });
    updateExportTask(this.db, task.id, { progress: 88, updated_at: timestamp() });
    const probe = await probeMedia(output, { ffprobePath: this.ffprobePath });
    const asset = createMediaAsset(this.db, {
      id: randomUUID(), projectId: project.id, type: 'export', provider: 'ffmpeg', model: 'ffmpeg-export-v1',
      objectKey, durationMs: probe.durationMs, sizeBytes: probe.sizeBytes, metadata: {
        ratio: task.ratio, resolution: task.resolution, actualDurationMs: probe.durationMs, probe,
      },
    });
    updateExportTask(this.db, task.id, {
      status: 'succeeded', progress: 100, object_key: asset.object_key, size_bytes: asset.size_bytes,
      completed_at: timestamp(), updated_at: timestamp(),
    });
    updateProject(this.db, project.id, { status: 'exported', updated_at: timestamp() });
  }

  async concatSegments({ output, segments }) {
    const listPath = `${output}.concat.txt`;
    const lines = segments.map(segment => `file '${resolve(this.mediaRoot, segment.objectKey).replaceAll("'", "'\\''")}'`);
    await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');
    try {
      await run(this.ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', output]);
    } finally {
      await rm(listPath, { force: true });
    }
  }

  fail(task, code, message) {
    updateExportTask(this.db, task.id, {
      status: 'failed', progress: 0, error_code: code, error_message: message,
      completed_at: timestamp(), updated_at: timestamp(),
    });
    updateProject(this.db, task.project_id, { status: 'ready', updated_at: timestamp() });
    this.logger.error?.(`[export-task] ${task.id} failed: ${code}`);
  }

  recover(taskIds) { taskIds.forEach(taskId => this.enqueue(taskId)); }
}

export async function waitForExportTask(runner, taskId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = getExportTask(runner.db, taskId);
    if (task && doneStates.has(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return getExportTask(runner.db, taskId);
}


function safe(value) { return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(Object.assign(new Error(`FFmpeg 启动失败: ${error.message}`), { code: 'FFMPEG_NOT_FOUND' })));
    child.on('close', code => code === 0 ? resolvePromise() : reject(Object.assign(new Error(`FFmpeg 导出失败: ${stderr.slice(-1200)}`), { code: 'FFMPEG_EXPORT_FAILED' })));
  });
}
