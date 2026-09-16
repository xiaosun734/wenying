import { randomUUID } from 'node:crypto';
import {
  createGenerationTask,
  createMediaAsset,
  createSegmentVersion,
  createSegmentShot,
  getChildGenerationTask,
  getGenerationTask,
  getLatestSegmentVersion,
  getLatestVisualBible,
  getProject,
  getSegment,
  getSegmentVersion,
  getSegmentVersionForPlan,
  getStoryboardPlan,
  listGenerationTasks,
  listMediaAssets,
  listSegments,
  listSegmentShots,
  listShotTransitions,
  getSegmentShot,
  timestamp,
  updateGenerationTask,
  updateProject,
  updateSegmentDuration,
  updateSegmentMedia,
  updateSegmentVersion,
  updateSegmentShot,
} from './db.mjs';
import { optionalPrompt, renderPrompt } from './prompt-config.mjs';
import { buildGenerationSpec, compileVideoPrompt } from './storyboard-task.mjs';

const doneStates = new Set(['succeeded', 'failed', 'canceled']);

function defaultPrompt(project, segment) {
  return renderPrompt(optionalPrompt('VIDEO_DEFAULT_PROMPT_TEMPLATE'), {
    genre: project.genre,
    summaryOrTitle: segment.summary || segment.title,
    title: segment.title,
    summary: segment.summary || '',
  });
}

function assetByType(assets, type) {
  return assets.find(asset => asset.type === type && asset.status === 'ready');
}

export class MediaTaskRunner {
  constructor({ db, provider, ttsProvider = null, subtitleProvider = null, textProvider = null, composer = null, requireAudio = true, logger = console }) {
    this.db = db;
    this.provider = provider;
    this.ttsProvider = ttsProvider;
    this.subtitleProvider = subtitleProvider;
    this.requireAudio = Boolean(requireAudio);
    this.textProvider = textProvider;
    this.composer = composer;
    this.logger = logger;
    this.queued = new Set();
  }

  enqueue(taskId) {
    if (this.queued.has(taskId)) return;
    this.queued.add(taskId);
    queueMicrotask(async () => {
      try {
        await this.run(taskId);
      } finally {
        this.queued.delete(taskId);
      }
    });
  }

  async run(taskId) {
    const task = getGenerationTask(this.db, taskId);
    if (!task || doneStates.has(task.status)) return;
    try {
      if (task.type === 'video') await this.runProjectTask(task);
      else if (task.type === 'segment') await this.runSegmentTask(task);
    } catch (error) {
      const message = error?.message || '视频生成失败，请稍后重试';
      updateGenerationTask(this.db, task.id, {
        status: 'failed', current_step: 'failed', error_code: error?.code || 'MEDIA_TASK_FAILED',
        error_message: message, completed_at: timestamp(), updated_at: timestamp(),
      });
      if (!task.parent_task_id) updateProject(this.db, task.project_id, { status: 'video_failed', updated_at: timestamp() });
      this.logger.error?.(`[media-task] ${task.id} failed: ${error?.code || 'MEDIA_TASK_FAILED'}`);
    }
  }

  async runProjectTask(task) {
    const project = getProject(this.db, task.project_id);
    if (!project) throw Object.assign(new Error('作品不存在'), { code: 'PROJECT_NOT_FOUND' });
    const scriptVersionId = project.active_script_version_id;
    if (!scriptVersionId) throw Object.assign(new Error('文案尚未确认'), { code: 'SCRIPT_NOT_CONFIRMED' });
    const segments = listSegments(this.db, scriptVersionId);
    if (!segments.length) throw Object.assign(new Error('没有可生成的片段'), { code: 'SEGMENTS_EMPTY' });

    updateGenerationTask(this.db, task.id, {
      status: 'running', current_step: 'preparing', progress: 3, started_at: timestamp(), updated_at: timestamp(),
    });
    updateProject(this.db, project.id, { status: 'video_processing', active_generation_task_id: task.id, updated_at: timestamp() });

    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const current = getGenerationTask(this.db, task.id);
      if (current?.status === 'canceled') break;
      const segment = segments[index];
      const child = this.ensureChildTask(task, project, segment);
      if (child.status === 'succeeded') {
        succeeded += 1;
      } else {
        await this.runSegmentTask(child);
        const completedChild = getGenerationTask(this.db, child.id);
        if (completedChild?.status === 'succeeded') succeeded += 1;
        else failed += 1;
      }
      const progress = Math.round(((index + 1) / segments.length) * 92);
      updateGenerationTask(this.db, task.id, {
        current_step: 'generating_segments', progress, updated_at: timestamp(),
      });
    }

    const refreshed = getGenerationTask(this.db, task.id);
    if (refreshed?.status === 'canceled') {
      updateProject(this.db, project.id, { status: succeeded ? 'partial_failed' : 'script_confirmed', updated_at: timestamp() });
      return;
    }

    updateGenerationTask(this.db, task.id, { current_step: 'finalizing_segments', progress: 95, updated_at: timestamp() });

    const childTasks = listGenerationTasks(this.db, task.id);
    failed = childTasks.filter(item => item.status === 'failed').length;
    succeeded = childTasks.filter(item => item.status === 'succeeded').length;
    const status = failed ? 'partial_failed' : 'succeeded';
    updateGenerationTask(this.db, task.id, {
      status, current_step: status === 'succeeded' ? 'completed' : 'partial_failed', progress: 100,
      completed_at: timestamp(), updated_at: timestamp(),
    });
    updateProject(this.db, project.id, { status: failed ? 'partial_failed' : 'ready', updated_at: timestamp() });
  }

  ensureChildTask(parentTask, project, segment) {
    const existing = getChildGenerationTask(this.db, parentTask.id, segment.id);
    if (existing) {
      if (existing.status === 'failed') {
        updateGenerationTask(this.db, existing.id, {
          status: 'pending', current_step: 'queued', progress: 0, error_code: null, error_message: null,
          started_at: null, completed_at: null, updated_at: timestamp(),
        });
      }
      return getGenerationTask(this.db, existing.id);
    }
    const config = parentTask.configuration || {};
    const plannedVersion = config.storyboardPlanId
      ? getSegmentVersionForPlan(this.db, segment.id, config.storyboardPlanId)
      : null;
    const existingVersion = plannedVersion || getLatestSegmentVersion(this.db, segment.id);
    const version = existingVersion?.source?.startsWith('storyboard')
      ? existingVersion
      : createSegmentVersion(this.db, {
        id: randomUUID(), segmentId: segment.id, source: 'generation', scriptText: segment.script_text,
        promptText: defaultPrompt(project, segment), voiceId: config.voiceId || 'magnetic',
        visualStyle: config.visualStyle || 'cinematic', durationMs: segment.duration_ms,
      });
    if (existingVersion?.source?.startsWith('storyboard')) {
      updateSegmentVersion(this.db, version.id, { voice_id: config.voiceId || version.voice_id, visual_style: config.visualStyle || version.visual_style, updated_at: timestamp() });
    }
    return createGenerationTask(this.db, {
      id: randomUUID(), projectId: project.id, parentTaskId: parentTask.id, segmentId: segment.id,
      segmentVersionId: version.id, type: 'segment', configuration: config,
      provider: this.provider.provider, model: this.provider.model,
      idempotencyKey: `${parentTask.id}:${segment.id}`,
    });
  }

  async runSegmentTask(task) {
    const project = getProject(this.db, task.project_id);
    const segment = task.segment_id ? getSegment(this.db, task.segment_id) : null;
    const version = task.segment_version_id ? getSegmentVersion(this.db, task.segment_version_id) : null;
    if (!project || !segment || !version) throw Object.assign(new Error('片段生成数据不存在'), { code: 'SEGMENT_TASK_INVALID' });

    updateGenerationTask(this.db, task.id, { status: 'running', current_step: 'generating_audio', progress: 8, started_at: timestamp(), updated_at: timestamp() });
    updateSegmentVersion(this.db, version.id, { status: 'generating_audio', updated_at: timestamp() });
    updateSegmentMedia(this.db, segment.id, { media_status: segment.active_version_id ? 'regenerating' : 'generating', updated_at: timestamp() });

    try {
      let assets = listMediaAssets(this.db, { segmentVersionId: version.id });
      if (!assetByType(assets, 'audio')) {
        if (this.ttsProvider) {
          const audio = await this.ttsProvider.synthesize({ project, segmentVersion: version });
          createMediaAsset(this.db, {
            id: randomUUID(), projectId: project.id, segmentVersionId: version.id, type: 'audio',
            provider: this.ttsProvider.provider, model: this.ttsProvider.model, objectKey: audio.objectKey,
            durationMs: audio.durationMs, sizeBytes: audio.sizeBytes, metadata: audio.metadata,
          });
        } else if (this.requireAudio) {
          throw Object.assign(new Error('Real TTS provider is not configured'), { code: 'TTS_NOT_CONFIGURED' });
        }
      }

      const refreshedAudio = listMediaAssets(this.db, { segmentVersionId: version.id });
      const audio = assetByType(refreshedAudio, 'audio');
      const actualDurationMs = Number(audio?.durationMs || audio?.duration_ms || version.duration_ms);
      if (actualDurationMs > 0 && actualDurationMs !== version.duration_ms) {
        updateSegmentVersion(this.db, version.id, { duration_ms: actualDurationMs, updated_at: timestamp() });
        updateSegmentDuration(this.db, segment.id, actualDurationMs);
      }
      let shots = await this.ensureShots(project, segment, version, task, audio);
      shots = this.ensureGenerationSpecs(project, shots);
      updateGenerationTask(this.db, task.id, { current_step: 'generating_shots', progress: 48, updated_at: timestamp() });
      for (const shot of shots) {
        const current = getGenerationTask(this.db, task.id);
        if (current?.status === 'canceled') throw Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELED' });
        let shotAssets = listMediaAssets(this.db, { segmentVersionId: version.id }).filter(item => item.shot_id === shot.id && item.type === 'shot_video' && item.status === 'ready');
        try {
          if (!shotAssets.length) {
            const video = await this.provider.generateVideo({ project, segmentVersion: version, shot });
            createMediaAsset(this.db, { id: randomUUID(), projectId: project.id, segmentVersionId: version.id, shotId: shot.id, type: 'shot_video', provider: this.provider.provider, model: this.provider.model, objectKey: video.objectKey, durationMs: video.durationMs, sizeBytes: video.sizeBytes, metadata: video.metadata });
            if (video.metadata?.promptId) {
              updateSegmentShot(this.db, shot.id, { provider_job_id: video.metadata.promptId, updated_at: timestamp() });
            }
          }
        } catch (error) {
          updateSegmentShot(this.db, shot.id, { status: 'failed', updated_at: timestamp() });
          throw error;
        }
        updateSegmentShot(this.db, shot.id, { status: 'ready', provider: this.provider.provider, model: this.provider.model, updated_at: timestamp() });
      }

      updateGenerationTask(this.db, task.id, { current_step: 'generating_subtitles', progress: 74, updated_at: timestamp() });
      updateSegmentVersion(this.db, version.id, { status: 'generating_subtitles', updated_at: timestamp() });
      assets = listMediaAssets(this.db, { segmentVersionId: version.id });
      if (!assetByType(assets, 'subtitle')) {
        if (!this.subtitleProvider) throw Object.assign(new Error('Subtitle provider is not configured'), { code: 'SUBTITLE_NOT_CONFIGURED' });
        const subtitle = await this.subtitleProvider.createSubtitles({ project, segmentVersion: { ...version, duration_ms: actualDurationMs } });
        createMediaAsset(this.db, {
          id: randomUUID(), projectId: project.id, segmentVersionId: version.id, type: 'subtitle',
          provider: this.subtitleProvider.provider, model: this.subtitleProvider.model, objectKey: subtitle.objectKey,
          durationMs: subtitle.durationMs, sizeBytes: subtitle.sizeBytes, metadata: subtitle.metadata,
        });
      }

      updateGenerationTask(this.db, task.id, { current_step: 'composing_segment', progress: 82, updated_at: timestamp() });
      const allAssets = listMediaAssets(this.db, { segmentVersionId: version.id });
      const shotAssets = shots.map(shot => ({ ...shot, objectKey: allAssets.find(item => item.shot_id === shot.id && item.type === 'shot_video' && item.status === 'ready')?.objectKey })).filter(item => item.objectKey);
      const transitions = version.storyboard_plan_id ? listShotTransitions(this.db, version.storyboard_plan_id) : [];
      const composer = this.composer;
      const composed = composer
        ? await composer.composeSegment({ project, segmentVersion: { ...version, duration_ms: actualDurationMs }, shots: shotAssets, transitions, audioAsset: audio })
        : await this.provider.generateVideo({ project, segmentVersion: version });
      if (!assetByType(listMediaAssets(this.db, { segmentVersionId: version.id }), 'video')) {
        createMediaAsset(this.db, { id: randomUUID(), projectId: project.id, segmentVersionId: version.id, type: 'video', provider: composer?.provider || this.provider.provider, model: composer?.model || this.provider.model, objectKey: composed.objectKey, durationMs: composed.durationMs, sizeBytes: composed.sizeBytes, metadata: composed.metadata });
      }

      updateSegmentVersion(this.db, version.id, { status: 'ready', updated_at: timestamp() });
      updateSegmentMedia(this.db, segment.id, { active_version_id: version.id, media_status: 'ready', updated_at: timestamp() });
      updateGenerationTask(this.db, task.id, {
        status: 'succeeded', current_step: 'completed', progress: 100, completed_at: timestamp(), updated_at: timestamp(),
      });
      if (!task.parent_task_id) {
        updateProject(this.db, project.id, { status: 'ready', active_generation_task_id: task.id, updated_at: timestamp() });
      }
    } catch (error) {
      updateSegmentVersion(this.db, version.id, { status: 'failed', updated_at: timestamp() });
      const current = getSegment(this.db, segment.id);
      updateSegmentMedia(this.db, segment.id, { media_status: current?.active_version_id ? 'ready' : 'failed', updated_at: timestamp() });
      updateGenerationTask(this.db, task.id, {
        status: 'failed', current_step: 'failed', error_code: error?.code || 'SEGMENT_GENERATION_FAILED',
        error_message: error?.message || '该片段生成失败，请稍后重试', completed_at: timestamp(), updated_at: timestamp(),
      });
      if (!task.parent_task_id) {
        updateProject(this.db, project.id, { status: 'ready', active_generation_task_id: task.id, updated_at: timestamp() });
      }
    }
  }

  async ensureShots(project, segment, version, task, audioAsset) {
    let shots = listSegmentShots(this.db, version.id);
    const durationMs = Number(audioAsset?.durationMs || audioAsset?.duration_ms || version.duration_ms || segment.duration_ms || 5000);
    if (shots.length) {
      const durations = distributeShotDurations(durationMs, shots);
      shots.forEach((shot, index) => {
        if (shot.duration_ms !== durations[index]) {
          updateSegmentShot(this.db, shot.id, { duration_ms: durations[index], updated_at: timestamp() });
        }
      });
      return listSegmentShots(this.db, version.id);
    }
    const count = Math.max(1, Math.ceil(durationMs / 5000));
    let planned = null;
    if (this.textProvider?.generateShotPrompts) {
      planned = await this.textProvider.generateShotPrompts({ scriptText: version.script_text, summary: segment.summary, genre: project.genre, count, idempotencyKey: `${task.id}:shots` });
    }
    const zh = Array.isArray(planned?.shots) ? planned.shots : [];
    const fallbackPrompt = optionalPrompt('VIDEO_FALLBACK_SHOT_PROMPT_TEMPLATE');
    const normalized = Array.from({ length: count }, (_, index) => ({
      sequence: index + 1,
      promptZh: String(zh[index]?.promptZh || renderPrompt(fallbackPrompt, {
        title: segment.title,
        sequence: index + 1,
      })),
    }));
    const each = Math.floor(durationMs / count);
    const rows = normalized.map((item, index) => createSegmentShot(this.db, { id: randomUUID(), segmentVersionId: version.id, sequence: item.sequence, promptZh: item.promptZh, durationMs: index === count - 1 ? durationMs - each * (count - 1) : each, status: 'ready' }));
    return listSegmentShots(this.db, version.id);
  }

  ensureGenerationSpecs(project, shots) {
    const bible = getLatestVisualBible(this.db, project.id);
    return shots.map(shot => {
      if (shot.generation_spec?.version) return shot;
      const plan = shot.storyboard_plan_id ? getStoryboardPlan(this.db, shot.storyboard_plan_id) : null;
      const beat = plan?.director_analysis?.segments
        ?.flatMap(item => item.beats || [])
        .find(item => item.beatId === shot.beat_id);
      const editableShot = {
        plot: shot.plot_text,
        shotSize: shot.shot_size,
        movement: shot.camera_movement,
        angle: shot.camera_angle,
        focalLengthMm: shot.focal_length_mm,
        composition: shot.composition,
        purpose: shot.narrative_purpose,
      };
      const generationSpec = buildGenerationSpec(editableShot, beat, bible?.content || {}, plan?.configuration || {});
      return updateSegmentShot(this.db, shot.id, {
        prompt_zh: compileVideoPrompt(editableShot, bible?.content || {}, plan?.configuration || {}, generationSpec),
        generation_spec_json: JSON.stringify(generationSpec),
        updated_at: timestamp(),
      });
    });
  }

  retry(taskId) {
    const task = getGenerationTask(this.db, taskId);
    if (!task || !['failed', 'partial_failed', 'canceled'].includes(task.status)) return null;
    updateGenerationTask(this.db, task.id, {
      status: 'pending', current_step: 'queued', progress: 0, retry_count: task.retry_count + 1,
      error_code: null, error_message: null, started_at: null, completed_at: null, updated_at: timestamp(),
    });
    updateProject(this.db, task.project_id, { status: 'video_queued', active_generation_task_id: task.id, updated_at: timestamp() });
    this.enqueue(task.id);
    return getGenerationTask(this.db, task.id);
  }

  recover(taskIds) {
    taskIds.forEach(taskId => this.enqueue(taskId));
  }
}

export function distributeShotDurations(totalMs, shots) {
  const total = Math.max(1, Math.round(Number(totalMs) || 1));
  const weights = shots.map(shot => Math.max(1, Number(shot.duration_ms || shot.durationMs || 1)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let used = 0;
  return weights.map((weight, index) => {
    const duration = index === weights.length - 1
      ? total - used
      : Math.max(1, Math.round(total * weight / weightTotal));
    used += duration;
    return duration;
  });
}

export async function waitForGenerationTask(runner, taskId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = getGenerationTask(runner.db, taskId);
    if (task && doneStates.has(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return getGenerationTask(runner.db, taskId);
}
