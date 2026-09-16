import { randomUUID } from 'node:crypto';
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
  constructor({ db, logger = console, stepDelayMs = 220 }) {
    this.db = db;
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
    const readySegments = segments.filter(segment => {
      if (!segment.active_version_id) return false;
      return assets.some(asset => asset.segment_version_id === segment.active_version_id && asset.type === 'video' && asset.status === 'ready');
    });
    if (!segments.length || readySegments.length !== segments.length) {
      return this.fail(task, 'EXPORT_ASSETS_NOT_READY', '仍有片段没有可用视频素材');
    }

    updateProject(this.db, project.id, { status: 'exporting', updated_at: timestamp() });
    updateExportTask(this.db, task.id, { status: 'running', progress: 12, updated_at: timestamp() });
    await new Promise(resolve => setTimeout(resolve, this.stepDelayMs));
    updateExportTask(this.db, task.id, { progress: 68, updated_at: timestamp() });
    await new Promise(resolve => setTimeout(resolve, this.stepDelayMs));
    const objectKey = `mock/exports/${project.id}/${task.id}.mp4`;
    const sizeBytes = Math.max(1024 * 512, readySegments.reduce((total, segment) => total + segment.duration_ms, 0) * 128);
    createMediaAsset(this.db, {
      id: randomUUID(), projectId: project.id, type: 'export', provider: 'mock', model: 'mock-render-v1',
      objectKey, sizeBytes, metadata: { ratio: task.ratio, resolution: task.resolution, aiLabel: true },
    });
    updateExportTask(this.db, task.id, {
      status: 'succeeded', progress: 100, object_key: objectKey, size_bytes: sizeBytes,
      completed_at: timestamp(), updated_at: timestamp(),
    });
    updateProject(this.db, project.id, { status: 'exported', updated_at: timestamp() });
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
