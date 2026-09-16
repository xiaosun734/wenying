import { randomUUID } from 'node:crypto';
import {
  createProject,
  createScriptVersion,
  createSegment,
  createTask,
  getProject,
  getScriptVersion,
  getSegment,
  getTask,
  getTaskByIdempotency,
  getLatestTask,
  createGenerationTask,
  createExportTask,
  createSegmentVersion,
  createSegmentShot,
  createStoryboardPlan,
  createStoryboardTask,
  getGenerationTask,
  getGenerationTaskByIdempotency,
  getExportTask,
  getExportTaskByIdempotency,
  getLatestGenerationTask,
  getLatestSegmentVersion,
  getSegmentVersion,
  getSegmentVersionForPlan,
  getSegmentShot,
  getStoryboardPlan,
  getStoryboardTask,
  getStoryboardTaskByIdempotency,
  getLatestStoryboardPlan,
  getLatestStoryboardTask,
  listGenerationTasks,
  listExportTasks,
  listMediaAssets,
  listProjects,
  listScriptVersions,
  listSegments,
  listSegmentShots,
  listShotTransitions,
  listRetrievalRuns,
  isVersionImmutable,
  transaction,
  updateProject,
  updateSegmentDraft,
  timestamp,
  updateGenerationTask,
  updateSegmentShot,
  invalidateShotAssets,
  updateStoryboardPlan,
  updateStoryboardTask,
  createVisualBible,
  getLatestVisualBible,
  getVisualBible,
  updateVisualBible,
} from './db.mjs';
import { auditText, cleanSourceText } from './safety.mjs';
import { PROMPT_VERSION, DIRECTOR_PROMPT_VERSION, CAMERA_PROMPT_VERSION, STORYBOARD_PROMPT_VERSION } from './providers/openai-compatible.mjs';
import { buildGenerationSpec, compileVideoPrompt } from './storyboard-task.mjs';
import { AdminDbError, deleteAdminRow, getAdminOverview, listAdminRows, listAdminTables, updateAdminRow } from './admin-db.mjs';

const JSON_LIMIT = 2 * 1024 * 1024;
const allowedGenres = new Set(['玄幻', '都市', '悬疑', '言情', '历史', '科幻', '其他', 'fantasy', 'urban', 'mystery', 'romance', 'history', 'scifi', 'other']);
const allowedVisualStyles = new Set(['cinematic', 'realistic', 'anime', 'chinese', 'cyberpunk']);
const allowedVoiceIds = new Set(['steady', 'sweet', 'magnetic']);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const ok = (res, body, status = 200) => json(res, status, body);

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > JSON_LIMIT) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求格式无效');
  }
}

function requireString(value, field, { min = 1, max = 1000000 } = {}) {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${field}格式无效`);
  const length = Array.from(value).length;
  if (length < min || length > max) throw new ApiError(400, 'INVALID_INPUT', `${field}长度不符合要求`);
  return value;
}

function projectDto(project) {
  if (!project) return null;
  return {
    id: project.id,
    title: project.title,
    genre: project.genre,
    status: project.status,
    copyrightConfirmed: Boolean(project.copyright_confirmed),
    activeScriptVersionId: project.active_script_version_id,
    draftScriptVersionId: project.draft_script_version_id,
    activeGenerationTaskId: project.active_generation_task_id || null,
    activeStoryboardPlanId: project.active_storyboard_plan_id || null,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

function projectListDto(db, project) {
  const versionId = project.active_script_version_id || project.draft_script_version_id;
  const segments = versionId ? listSegments(db, versionId) : [];
  const durationMs = segments.reduce((total, segment) => total + Number(segment.duration_ms || 0), 0);
  return {
    ...projectDto(project),
    segmentCount: segments.length,
    durationMs,
    duration: formatDuration(durationMs),
  };
}

function taskDto(task) {
  if (!task) return null;
  return {
    id: task.id,
    projectId: task.project_id,
    status: task.status,
    step: task.current_step,
    progress: task.progress,
    errorCode: task.error_code,
    errorMessage: task.error_message,
    retryCount: task.retry_count,
    provider: task.provider,
    model: task.model,
    promptVersion: task.prompt_version,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  };
}

function versionDto(version) {
  if (!version) return null;
  return {
    id: version.id,
    projectId: version.project_id,
    source: version.source,
    immutable: version.immutable,
    promptVersion: version.prompt_version,
    provider: version.provider,
    model: version.model,
    createdAt: version.created_at,
  };
}

function segmentDto(db, segment, storyboardPlanId = null) {
  const activeVersion = segment.active_version_id ? getSegmentVersion(db, segment.active_version_id) : null;
  const plannedVersion = storyboardPlanId ? getSegmentVersionForPlan(db, segment.id, storyboardPlanId) : null;
  const latestVersion = activeVersion?.source === 'user-regenerate'
    ? activeVersion
    : plannedVersion || activeVersion || getLatestSegmentVersion(db, segment.id);
  const assets = latestVersion ? listMediaAssets(db, { segmentVersionId: latestVersion.id }) : [];
  const shots = latestVersion ? listSegmentShots(db, latestVersion.id) : [];
  return {
    id: segment.id,
    projectId: segment.project_id,
    scriptVersionId: segment.script_version_id,
    sequence: segment.sequence,
    title: segment.title,
    scriptText: segment.script_text,
    summary: segment.summary || '',
    durationMs: segment.duration_ms,
    duration: formatDuration(segment.duration_ms),
    revision: segment.revision,
    updatedAt: segment.updated_at,
    mediaStatus: segment.media_status || 'pending',
    activeVersionId: segment.active_version_id || null,
    versionId: latestVersion?.id || null,
    promptText: latestVersion?.prompt_text || '',
    voiceId: latestVersion?.voice_id || 'magnetic',
    visualStyle: latestVersion?.visual_style || 'cinematic',
    shots: shots.map(shot => ({
      id: shot.id, sequence: shot.sequence, beatId: shot.beat_id, plot: shot.plot_text,
      shotSize: shot.shot_size, movement: shot.camera_movement, angle: shot.camera_angle,
      focalLengthMm: shot.focal_length_mm, composition: shot.composition, purpose: shot.narrative_purpose,
      selectionReason: shot.selection_reason, evidenceIds: shot.evidence_ids || [], promptZh: shot.prompt_zh, promptEn: shot.prompt_en,
      generationSpec: shot.generation_spec || {},
      durationMs: shot.duration_ms, duration: formatDuration(shot.duration_ms), status: shot.status,
      media: assets.filter(asset => asset.shot_id === shot.id).map(asset => ({ id: asset.id, type: asset.type, objectKey: asset.object_key, durationMs: asset.duration_ms, status: asset.status })),
    })),
    media: assets.filter(asset => !asset.shot_id).map(asset => ({
      id: asset.id,
      type: asset.type,
      durationMs: asset.duration_ms,
      status: asset.status,
      objectKey: asset.object_key,
      url: asset.object_key?.startsWith('projects/') ? `/media/${asset.object_key}` : null,
      metadata: asset.metadata,
    })),
  };
}

function generationTaskDto(task) {
  if (!task) return null;
  return {
    id: task.id,
    projectId: task.project_id,
    parentTaskId: task.parent_task_id,
    segmentId: task.segment_id,
    segmentVersionId: task.segment_version_id,
    type: task.type,
    status: task.status,
    step: task.current_step,
    progress: task.progress,
    retryCount: task.retry_count,
    errorCode: task.error_code,
    errorMessage: task.error_message,
    provider: task.provider,
    model: task.model,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  };
}

function storyboardTaskDto(task) {
  if (!task) return null;
  return {
    id: task.id, projectId: task.project_id, storyboardPlanId: task.storyboard_plan_id,
    status: task.status, step: task.current_step, progress: task.progress, fromLayer: task.from_layer,
    retryCount: task.retry_count, errorCode: task.error_code, errorMessage: task.error_message,
    provider: task.provider, model: task.model, createdAt: task.created_at, updatedAt: task.updated_at,
    completedAt: task.completed_at,
  };
}

function storyboardPlanDto(db, plan) {
  if (!plan) return null;
  return {
    id: plan.id, projectId: plan.project_id, scriptVersionId: plan.script_version_id, basePlanId: plan.base_plan_id,
    status: plan.status, revision: plan.revision, configuration: plan.configuration,
    directorAnalysis: plan.director_analysis, shotSelection: plan.shot_selection,
    knowledgeSnapshot: plan.knowledge_snapshot, promptVersions: plan.prompt_versions,
    confirmedAt: plan.confirmed_at, createdAt: plan.created_at, updatedAt: plan.updated_at,
    transitions: listShotTransitions(db, plan.id).map(item => ({
      id: item.id, fromShotId: item.from_shot_id, toShotId: item.to_shot_id, type: item.type,
      durationMs: item.duration_ms, motivation: item.motivation, execution: item.execution,
      evidenceIds: item.evidence_ids,
    })),
  };
}

function exportTaskDto(task) {
  if (!task) return null;
  return {
    id: task.id,
    projectId: task.project_id,
    status: task.status,
    ratio: task.ratio,
    resolution: task.resolution,
    progress: task.progress,
    objectKey: task.object_key,
    sizeBytes: task.size_bytes,
    errorCode: task.error_code,
    errorMessage: task.error_message,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  };
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const min = Math.floor(total / 60);
  return `${min}:${String(total % 60).padStart(2, '0')}`;
}

function projectState(db, id) {
  const project = getProject(db, id);
  if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', '作品不存在');
  const task = getLatestTask(db, id);
  const generationTask = project.active_generation_task_id
    ? getGenerationTask(db, project.active_generation_task_id)
    : getLatestGenerationTask(db, id);
  const versionId = project.active_script_version_id || project.draft_script_version_id;
  const version = versionId ? getScriptVersion(db, versionId) : null;
  const storyboardPlan = project.active_storyboard_plan_id
    ? getStoryboardPlan(db, project.active_storyboard_plan_id)
    : getLatestStoryboardPlan(db, id);
  const segments = version ? listSegments(db, version.id).map(segment => segmentDto(db, segment, storyboardPlan?.id)) : [];
  const generationChildren = generationTask?.type === 'video'
    ? listGenerationTasks(db, generationTask.id).map(generationTaskDto)
    : [];
  const storyboardTask = getLatestStoryboardTask(db, id);
  return {
    project: projectDto(project), task: taskDto(task), generationTask: generationTaskDto(generationTask),
    generationChildren, version: versionDto(version), visualBible: getLatestVisualBible(db, id), segments,
    storyboardPlan: storyboardPlanDto(db, storyboardPlan), storyboardTask: storyboardTaskDto(storyboardTask),
  };
}

export function createApi({ db, runner, provider, mediaRunner, mediaProvider, exportRunner, storyboardRunner }) {
  return async function handleApi(req, res, pathname) {
    try {
      const method = req.method || 'GET';
      const parts = pathname.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
      const query = new URLSearchParams(String(req.url || '').split('?')[1] || '');

      if (method === 'GET' && parts.length === 0) return ok(res, { ok: true, service: 'wenying-api' });

      if (parts[0] === 'admin') {
        if (method === 'GET' && parts[1] === 'overview' && parts.length === 2) {
          return ok(res, { overview: getAdminOverview(db) });
        }
        if (method === 'GET' && parts[1] === 'tables' && parts.length === 2) {
          return ok(res, { tables: listAdminTables(db) });
        }
        if (parts[1] === 'tables' && parts[2]) {
          const tableName = parts[2];
          if (method === 'GET' && parts.length === 3) {
            return ok(res, listAdminRows(db, tableName, {
              search: query.get('search') || '',
              limit: query.get('limit') || 50,
              offset: query.get('offset') || 0,
            }));
          }
          if (method === 'PATCH' && parts[3] && parts.length === 4) {
            const body = await readJson(req);
            return ok(res, { row: updateAdminRow(db, tableName, parts[3], body) });
          }
          if (method === 'DELETE' && parts[3] && parts.length === 4) {
            return ok(res, deleteAdminRow(db, tableName, parts[3]));
          }
        }
        throw new AdminDbError(404, 'ADMIN_NOT_FOUND', 'Admin endpoint not found');
      }

      if (method === 'POST' && parts[0] === 'projects' && parts.length === 1) {
        const body = await readJson(req);
        const title = requireString(String(body.title || '').trim(), '作品名称', { max: 50 });
        const genre = requireString(body.genre || '', '题材', { max: 30 });
        if (!allowedGenres.has(genre)) throw new ApiError(400, 'INVALID_GENRE', '请选择有效题材');
        requireString(body.sourceText || '', '正文', { max: 30000 });
        const sourceText = cleanSourceText(body.sourceText);
        if (!sourceText.trim()) throw new ApiError(400, 'INVALID_INPUT', '正文不能为空');
        if (!body.copyrightConfirmed) throw new ApiError(400, 'COPYRIGHT_REQUIRED', '请先确认你拥有内容的合法使用权');
        const audit = auditText(sourceText);
        if (!audit.ok) throw new ApiError(422, audit.code, audit.message);
        const retentionHours = Math.max(1, Number(process.env.SOURCE_RETENTION_HOURS || 24));
        const project = createProject(db, {
          id: randomUUID(), title, genre, sourceText, copyrightConfirmed: true,
          sourceExpiresAt: new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString(),
        });
        return ok(res, { project: projectDto(project) }, 201);
      }

      if (method === 'GET' && parts[0] === 'projects' && parts.length === 1) {
        return ok(res, { projects: listProjects(db).map(project => projectListDto(db, project)) });
      }

      if (parts[0] === 'projects' && parts[1] && parts.length >= 2) {
        const projectId = parts[1];
        if (method === 'GET' && parts.length === 2) return ok(res, projectState(db, projectId));

        if (method === 'POST' && parts[2] === 'script-tasks' && parts.length === 3) {
          const project = getProject(db, projectId);
          if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', '作品不存在');
          const existing = getLatestTask(db, projectId);
          if (existing && ['pending', 'running'].includes(existing.status)) return ok(res, { task: taskDto(existing), ...projectState(db, projectId) }, 202);
          const idempotencyKey = String(req.headers['idempotency-key'] || '').trim() || randomUUID();
          const duplicate = getTaskByIdempotency(db, projectId, idempotencyKey);
          if (duplicate) return ok(res, { task: taskDto(duplicate), ...projectState(db, projectId) }, 202);
          const task = createTask(db, {
            id: randomUUID(), projectId, idempotencyKey, provider: provider.provider, model: provider.model, promptVersion: PROMPT_VERSION,
          });
          updateProjectForTask(db, projectId);
          runner.enqueue(task.id);
          return ok(res, { task: taskDto(task), ...projectState(db, projectId) }, 202);
        }

        if (method === 'GET' && parts[2] === 'script-versions' && parts.length === 3) {
          const project = getProject(db, projectId);
          if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', '作品不存在');
          return ok(res, { versions: listScriptVersions(db, projectId).map(versionDto) });
        }

        if (method === 'GET' && parts[2] === 'segments' && parts.length === 3) {
          return ok(res, projectState(db, projectId));
        }

        if (method === 'POST' && parts[2] === 'script' && parts[3] === 'confirm' && parts.length === 4) {
          const state = projectState(db, projectId);
          if (!state.version || !state.segments.length) throw new ApiError(409, 'SCRIPT_NOT_READY', '文案尚未生成完成');
          if (state.segments.some(segment => !segment.scriptText.trim())) throw new ApiError(400, 'EMPTY_SEGMENT', '文案不能为空');
          const nextVersionId = randomUUID();
          transaction(db, () => {
            createScriptVersion(db, {
              id: nextVersionId,
              projectId,
              source: 'user-confirmed',
              immutable: true,
              promptVersion: state.version.promptVersion,
              provider: state.version.provider,
              model: state.version.model,
              cleanedText: state.segments.map(segment => segment.scriptText).join('\n\n'),
            });
            state.segments.forEach(segment => createSegment(db, {
              id: randomUUID(), projectId, scriptVersionId: nextVersionId, sequence: segment.sequence,
              title: segment.title, scriptText: segment.scriptText, summary: segment.summary,
              durationMs: segment.durationMs,
            }));
            const retentionHours = Math.max(1, Number(process.env.SOURCE_RETENTION_HOURS || 24));
            const expiresAt = new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString();
            updateProject(db, projectId, {
              status: 'script_confirmed',
              active_script_version_id: nextVersionId,
              source_expires_at: expiresAt,
              updated_at: timestamp(),
            });
          });
          return ok(res, projectState(db, projectId));
        }

      if (method === 'POST' && parts[2] === 'generation-tasks' && parts.length === 3) {
          const project = getProject(db, projectId);
          if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', '作品不存在');
          const body = await readJson(req);
          const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '').trim() || randomUUID();
          const duplicate = getGenerationTaskByIdempotency(db, projectId, 'video', idempotencyKey);
          if (duplicate) return ok(res, { ...projectState(db, projectId), task: generationTaskDto(duplicate) }, 202);
          const active = project.active_generation_task_id ? getGenerationTask(db, project.active_generation_task_id) : null;
          if (active && ['pending', 'running'].includes(active.status)) {
            return ok(res, { ...projectState(db, projectId), task: generationTaskDto(active) }, 202);
          }
          const storyboardPlan = project.active_storyboard_plan_id ? getStoryboardPlan(db, project.active_storyboard_plan_id) : null;
          if (!storyboardPlan || storyboardPlan.status !== 'confirmed' || storyboardPlan.script_version_id !== project.active_script_version_id) {
            throw new ApiError(409, 'STORYBOARD_NOT_CONFIRMED', '请先确认三层前期策划和分镜表');
          }
          const visualStyle = String(body.visualStyle || 'cinematic');
          const voiceId = String(body.voiceId || 'magnetic');
          if (!allowedVisualStyles.has(visualStyle)) throw new ApiError(400, 'INVALID_VISUAL_STYLE', '请选择有效画面风格');
          if (!allowedVoiceIds.has(voiceId)) throw new ApiError(400, 'INVALID_VOICE', '请选择有效配音音色');
          const task = createGenerationTask(db, {
            id: randomUUID(), projectId, type: 'video',
            configuration: {
              visualStyle, voiceId, storyboardPlanId: storyboardPlan.id,
              subtitleStyle: String(body.subtitleStyle || 'basic-outline'),
              bgmPolicy: String(body.bgmPolicy || 'auto'),
            },
            provider: mediaProvider.provider, model: mediaProvider.model, idempotencyKey,
          });
          updateProject(db, projectId, { status: 'video_queued', active_generation_task_id: task.id, updated_at: timestamp() });
          mediaRunner.enqueue(task.id);
          return ok(res, { ...projectState(db, projectId), task: generationTaskDto(task) }, 202);
        }
      }

      if (method === 'POST' && parts[0] === 'projects' && parts[1] && parts[2] === 'storyboard-tasks' && parts.length === 3) {
        const storyboardProjectId = parts[1];
        const project = getProject(db, storyboardProjectId);
        if (!project?.active_script_version_id) throw new ApiError(409, 'SCRIPT_NOT_CONFIRMED', '请先确认文案');
        const body = await readJson(req);
        const visualStyle = String(body.visualStyle || 'cinematic');
        const voiceId = String(body.voiceId || 'magnetic');
        const ratio = String(body.ratio || '9:16');
        if (!allowedVisualStyles.has(visualStyle)) throw new ApiError(400, 'INVALID_VISUAL_STYLE', '请选择有效画面风格');
        if (!allowedVoiceIds.has(voiceId)) throw new ApiError(400, 'INVALID_VOICE', '请选择有效配音音色');
        if (!['9:16', '16:9', '1:1'].includes(ratio)) throw new ApiError(400, 'INVALID_RATIO', '视频画幅无效');
        const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '').trim() || randomUUID();
        const duplicate = getStoryboardTaskByIdempotency(db, project.id, idempotencyKey);
        if (duplicate) return ok(res, { ...projectState(db, project.id), task: storyboardTaskDto(duplicate) }, 202);
        const active = getLatestStoryboardTask(db, project.id);
        if (active && ['pending', 'running'].includes(active.status)) return ok(res, { ...projectState(db, project.id), task: storyboardTaskDto(active) }, 202);
        const plan = createStoryboardPlan(db, {
          id: randomUUID(), projectId: project.id, scriptVersionId: project.active_script_version_id,
          configuration: { visualStyle, voiceId, ratio, platform: String(body.platform || 'short-video'), mediaModel: mediaProvider.model },
          promptVersions: { director: DIRECTOR_PROMPT_VERSION, camera: CAMERA_PROMPT_VERSION, storyboard: STORYBOARD_PROMPT_VERSION },
          provider: provider.provider, model: provider.model,
        });
        const task = createStoryboardTask(db, {
          id: randomUUID(), projectId: project.id, storyboardPlanId: plan.id, fromLayer: 'director', idempotencyKey,
          provider: provider.provider, model: provider.model,
        });
        updateProject(db, project.id, { status: 'storyboard_queued', active_storyboard_plan_id: plan.id, updated_at: timestamp() });
        storyboardRunner.enqueue(task.id);
        return ok(res, { ...projectState(db, project.id), task: storyboardTaskDto(task) }, 202);
      }

      if (parts[0] === 'storyboard-tasks' && parts[1]) {
        const task = getStoryboardTask(db, parts[1]);
        if (!task) throw new ApiError(404, 'STORYBOARD_TASK_NOT_FOUND', '前期策划任务不存在');
        if (method === 'GET' && parts.length === 2) return ok(res, { ...projectState(db, task.project_id), task: storyboardTaskDto(task) });
        if (method === 'POST' && parts[2] === 'retry' && parts.length === 3) {
          if (!['failed', 'canceled'].includes(task.status)) throw new ApiError(409, 'TASK_NOT_RETRYABLE', '当前任务不可重试');
          const updated = updateStoryboardTask(db, task.id, {
            status: 'pending', current_step: 'queued', progress: 0, retry_count: task.retry_count + 1,
            error_code: null, error_message: null, started_at: null, completed_at: null, updated_at: timestamp(),
          });
          storyboardRunner.enqueue(task.id);
          return ok(res, { ...projectState(db, task.project_id), task: storyboardTaskDto(updated) }, 202);
        }
      }

      if (parts[0] === 'storyboard-plans' && parts[1]) {
        const plan = getStoryboardPlan(db, parts[1]);
        if (!plan) throw new ApiError(404, 'STORYBOARD_PLAN_NOT_FOUND', '前期策划版本不存在');
        if (method === 'GET' && parts.length === 2) return ok(res, { storyboardPlan: storyboardPlanDto(db, plan) });
        if (method === 'GET' && parts[2] === 'retrievals' && parts.length === 3) {
          return ok(res, { retrievals: listRetrievalRuns(db, plan.id).map(item => ({ id: item.id, segmentId: item.segment_id, beatId: item.beat_id, query: item.query, results: item.results, strategyVersion: item.strategy_version })) });
        }
        if (method === 'PATCH' && ['director-analysis', 'shot-selection'].includes(parts[2]) && parts.length === 3) {
          if (plan.status === 'confirmed') throw new ApiError(409, 'STORYBOARD_IMMUTABLE', '已确认的前期策划不可修改，请创建重生成版本');
          const body = await readJson(req);
          const revision = Number(body.revision);
          if (!Number.isInteger(revision)) throw new ApiError(400, 'INVALID_REVISION', '策划版本号无效');
          const field = parts[2] === 'director-analysis' ? 'director_analysis' : 'shot_selection';
          const value = parts[2] === 'director-analysis' ? body.directorAnalysis : body.shotSelection;
          if (!value || typeof value !== 'object') throw new ApiError(400, 'INVALID_INPUT', '结构化策划内容不能为空');
          const updated = updateStoryboardPlan(db, plan.id, { [field]: value, status: 'edited', updated_at: timestamp() }, revision);
          if (!updated) throw new ApiError(409, 'REVISION_CONFLICT', '策划版本已被其他页面修改');
          return ok(res, { storyboardPlan: storyboardPlanDto(db, updated) });
        }
        if (method === 'POST' && parts[2] === 'confirm' && parts.length === 3) {
          if (plan.status !== 'review_ready' && plan.status !== 'edited') throw new ApiError(409, 'STORYBOARD_NOT_READY', '分镜表尚未准备完成');
          const updated = updateStoryboardPlan(db, plan.id, { status: 'confirmed', confirmed_at: timestamp(), updated_at: timestamp() });
          updateProject(db, plan.project_id, { status: 'storyboard_confirmed', active_storyboard_plan_id: plan.id, updated_at: timestamp() });
          return ok(res, { ...projectState(db, plan.project_id), storyboardPlan: storyboardPlanDto(db, updated) });
        }
        if (method === 'POST' && parts[2] === 'regenerate' && parts.length === 3) {
          const body = await readJson(req);
          const fromLayer = String(body.fromLayer || 'director');
          if (!['director', 'camera', 'storyboard'].includes(fromLayer)) throw new ApiError(400, 'INVALID_LAYER', '重生成层级无效');
          const project = getProject(db, plan.project_id);
          if (!project || plan.script_version_id !== project.active_script_version_id) throw new ApiError(409, 'STORYBOARD_OUTDATED', '策划版本与当前文案不一致');
          const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '').trim() || randomUUID();
          const duplicate = getStoryboardTaskByIdempotency(db, project.id, idempotencyKey);
          if (duplicate) return ok(res, { ...projectState(db, project.id), task: storyboardTaskDto(duplicate) }, 202);
          const nextPlan = createStoryboardPlan(db, {
            id: randomUUID(), projectId: project.id, scriptVersionId: plan.script_version_id, basePlanId: plan.id,
            configuration: plan.configuration,
            directorAnalysis: fromLayer === 'director' ? null : plan.director_analysis,
            shotSelection: fromLayer === 'storyboard' ? plan.shot_selection : null,
            knowledgeSnapshot: plan.knowledge_snapshot, promptVersions: plan.prompt_versions,
            provider: plan.provider, model: plan.model,
          });
          const task = createStoryboardTask(db, {
            id: randomUUID(), projectId: project.id, storyboardPlanId: nextPlan.id, fromLayer, idempotencyKey,
            provider: plan.provider, model: plan.model,
          });
          updateProject(db, project.id, { status: 'storyboard_queued', active_storyboard_plan_id: nextPlan.id, updated_at: timestamp() });
          storyboardRunner.enqueue(task.id);
          return ok(res, { ...projectState(db, project.id), task: storyboardTaskDto(task) }, 202);
        }
      }

      if (parts[0] === 'visual-bibles' && parts[1] && method === 'PATCH' && parts[2] === 'confirm') {
        const bible = getVisualBible(db, parts[1]);
        if (!bible) throw new ApiError(404, 'VISUAL_BIBLE_NOT_FOUND', '视觉设定不存在');
        const body = await readJson(req);
        const revision = Number(body.revision ?? bible.revision);
        const updated = updateVisualBible(db, bible.id, { content: body.content || bible.content, confirmed: true, revision });
        if (!updated) throw new ApiError(409, 'REVISION_CONFLICT', '视觉设定已被其他页面修改');
        return ok(res, { visualBible: updated });
      }

      if (parts[0] === 'script-tasks' && parts[1]) {
        const taskId = parts[1];
        if (method === 'GET' && parts.length === 2) {
          const task = getTask(db, taskId);
          if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', '任务不存在');
          return ok(res, { task: taskDto(task), ...projectState(db, task.project_id) });
        }
        if (method === 'POST' && parts[2] === 'retry' && parts.length === 3) {
          const task = runner.retry(taskId);
          if (!task) throw new ApiError(409, 'TASK_NOT_RETRYABLE', '当前任务不可重试');
          return ok(res, { task: taskDto(task), ...projectState(db, task.project_id) }, 202);
        }
      }

      if (parts[0] === 'generation-tasks' && parts[1]) {
        const taskId = parts[1];
        const task = getGenerationTask(db, taskId);
        if (!task) throw new ApiError(404, 'GENERATION_TASK_NOT_FOUND', '生成任务不存在');
        if (method === 'GET' && parts.length === 2) {
          return ok(res, { ...projectState(db, task.project_id), task: generationTaskDto(task) });
        }
        if (method === 'POST' && parts[2] === 'retry' && parts.length === 3) {
          const retried = mediaRunner.retry(task.id);
          if (!retried) throw new ApiError(409, 'TASK_NOT_RETRYABLE', '当前任务不可重试');
          return ok(res, { ...projectState(db, task.project_id), task: generationTaskDto(retried) }, 202);
        }
        if (method === 'POST' && parts[2] === 'cancel' && parts.length === 3) {
          if (!['pending', 'running'].includes(task.status)) throw new ApiError(409, 'TASK_NOT_CANCELLABLE', '当前任务不可取消');
          updateGenerationTask(db, task.id, {
            status: 'canceled', current_step: 'canceled', error_code: null, error_message: null,
            completed_at: timestamp(), updated_at: timestamp(),
          });
          updateProject(db, task.project_id, { status: 'partial_failed', updated_at: timestamp() });
          return ok(res, { ...projectState(db, task.project_id), task: generationTaskDto(getGenerationTask(db, task.id)) });
        }
      }

      if (parts[0] === 'export-tasks' && parts[1]) {
        const task = getExportTask(db, parts[1]);
        if (!task) throw new ApiError(404, 'EXPORT_TASK_NOT_FOUND', '导出任务不存在');
        if (method === 'GET' && parts.length === 2) return ok(res, { task: exportTaskDto(task) });
      }

      if (method === 'POST' && parts[0] === 'projects' && parts[1] && parts[2] === 'export-tasks' && parts.length === 3) {
        const project = getProject(db, parts[1]);
        if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', '作品不存在');
        if (!['ready', 'editing', 'exported'].includes(project.status)) throw new ApiError(409, 'PROJECT_NOT_READY', '视频片段尚未全部生成完成');
        const body = await readJson(req);
        const ratio = String(body.ratio || '9:16');
        const resolution = String(body.resolution || '1080p');
        if (!['9:16', '16:9', '1:1'].includes(ratio)) throw new ApiError(400, 'INVALID_RATIO', '导出比例无效');
        if (!['720p', '1080p'].includes(resolution)) throw new ApiError(400, 'INVALID_RESOLUTION', '导出分辨率无效');
        const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '').trim() || randomUUID();
        const duplicate = getExportTaskByIdempotency(db, project.id, idempotencyKey);
        if (duplicate) return ok(res, { task: exportTaskDto(duplicate) }, 202);
        const task = createExportTask(db, { id: randomUUID(), projectId: project.id, ratio, resolution, idempotencyKey });
        exportRunner.enqueue(task.id);
        return ok(res, { task: exportTaskDto(task) }, 202);
      }

      if (method === 'GET' && parts[0] === 'projects' && parts[1] && parts[2] === 'exports' && parts.length === 3) {
        const project = getProject(db, parts[1]);
        if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', '作品不存在');
        return ok(res, { exports: listExportTasks(db, project.id).map(exportTaskDto) });
      }

      if (parts[0] === 'segments' && parts[1] && method === 'PATCH' && parts[2] === 'draft') {
        const body = await readJson(req);
        const scriptText = cleanSourceText(requireString(body.scriptText || '', '文案', { max: 10000 }));
        if (!scriptText) throw new ApiError(400, 'EMPTY_SEGMENT', '文案不能为空');
        const revision = Number.isInteger(body.revision) ? body.revision : Number(body.revision);
        if (!Number.isInteger(revision) || revision < 0) throw new ApiError(400, 'INVALID_REVISION', '文案版本无效');
        const existingSegment = getSegment(db, parts[1]);
        if (!existingSegment) throw new ApiError(404, 'SEGMENT_NOT_FOUND', '片段不存在');
        if (isVersionImmutable(db, existingSegment.script_version_id)) {
          throw new ApiError(409, 'SCRIPT_VERSION_IMMUTABLE', '已确认的文案版本不可修改，请创建新的草稿');
        }
        const updated = updateSegmentDraft(db, parts[1], { scriptText, revision });
        if (!updated) {
          throw new ApiError(409, 'REVISION_CONFLICT', '文案已被其他页面修改，请刷新后重试');
        }
        updateProject(db, updated.project_id, { updated_at: timestamp() });
        return ok(res, { segment: segmentDto(db, updated) });
      }

      if (parts[0] === 'segments' && parts[1] && method === 'POST' && parts[2] === 'regenerate') {
        const body = await readJson(req);
        const segment = getSegment(db, parts[1]);
        if (!segment) throw new ApiError(404, 'SEGMENT_NOT_FOUND', '片段不存在');
        const project = getProject(db, segment.project_id);
        if (!project?.active_script_version_id) throw new ApiError(409, 'SCRIPT_NOT_CONFIRMED', '请先确认文案后再重新生成');
        const baseVersion = segment.active_version_id ? getSegmentVersion(db, segment.active_version_id) : getLatestSegmentVersion(db, segment.id);
        if (!baseVersion) throw new ApiError(409, 'SEGMENT_NOT_GENERATED', '该片段尚未生成，无法重新生成');
        const scriptText = body.scriptText === undefined
          ? baseVersion.script_text
          : cleanSourceText(requireString(body.scriptText, '文案', { max: 10000 }));
        if (!scriptText) throw new ApiError(400, 'EMPTY_SEGMENT', '文案不能为空');
        const promptText = body.promptText === undefined
          ? baseVersion.prompt_text
          : cleanSourceText(requireString(body.promptText, '画面提示词', { max: 1000 }));
        const voiceId = String(body.voiceId || baseVersion.voice_id);
        const visualStyle = String(body.visualStyle || baseVersion.visual_style);
        if (!allowedVoiceIds.has(voiceId)) throw new ApiError(400, 'INVALID_VOICE', '请选择有效配音音色');
        if (!allowedVisualStyles.has(visualStyle)) throw new ApiError(400, 'INVALID_VISUAL_STYLE', '请选择有效画面风格');
        const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '').trim() || randomUUID();
        const duplicate = getGenerationTaskByIdempotency(db, project.id, 'segment', idempotencyKey);
        if (duplicate) return ok(res, { ...projectState(db, project.id), task: generationTaskDto(duplicate) }, 202);
        const version = createSegmentVersion(db, {
          id: randomUUID(), segmentId: segment.id, source: 'user-regenerate', scriptText, promptText,
          voiceId, visualStyle, durationMs: segment.duration_ms,
        });
        if (Array.isArray(body.shots) && body.shots.length) {
          body.shots.slice(0, 50).forEach((inputShot, index) => {
            const promptZh = cleanSourceText(requireString(String(inputShot.promptZh || ''), '中文镜头提示词', { max: 2000 }));
            createSegmentShot(db, {
              id: randomUUID(), segmentVersionId: version.id, sequence: index + 1, promptZh,
              beatId: inputShot.beatId || null, plot: cleanSourceText(String(inputShot.plot || '')),
              shotSize: String(inputShot.shotSize || ''), movement: String(inputShot.movement || ''),
              angle: String(inputShot.angle || ''), focalLengthMm: Number(inputShot.focalLengthMm || 50),
              composition: String(inputShot.composition || ''), purpose: String(inputShot.purpose || ''),
              durationMs: Number(inputShot.durationMs || 0), selectionReason: String(inputShot.selectionReason || ''),
              evidenceIds: Array.isArray(inputShot.evidenceIds) ? inputShot.evidenceIds : [],
              promptEn: cleanSourceText(String(inputShot.promptEn || '')),
              generationSpec: inputShot.generationSpec || {}, status: 'pending',
            });
          });
        }
        const task = createGenerationTask(db, {
          id: randomUUID(), projectId: project.id, segmentId: segment.id, segmentVersionId: version.id,
          type: 'segment', configuration: { mode: 'regenerate' }, provider: mediaProvider.provider,
          model: mediaProvider.model, idempotencyKey,
        });
        updateProject(db, project.id, { status: 'video_processing', active_generation_task_id: task.id, updated_at: timestamp() });
        mediaRunner.enqueue(task.id);
        return ok(res, { ...projectState(db, project.id), task: generationTaskDto(task) }, 202);
      }

      if (parts[0] === 'shots' && parts[1] && method === 'PATCH' && (parts.length === 2 || parts[2] === 'prompt')) {
        const shot = getSegmentShot(db, parts[1]);
        if (!shot) throw new ApiError(404, 'SHOT_NOT_FOUND', '镜头不存在');
        const shotPlan = shot.storyboard_plan_id ? getStoryboardPlan(db, shot.storyboard_plan_id) : null;
        if (shotPlan?.status === 'confirmed') throw new ApiError(409, 'STORYBOARD_IMMUTABLE', '已确认的分镜不可原地修改，请从对应层重新生成');
        const body = await readJson(req);
        const fields = { status: 'pending', updated_at: timestamp() };
        if (body.promptZh !== undefined) fields.prompt_zh = cleanSourceText(requireString(body.promptZh, '中文镜头提示词', { max: 2000 }));
        if (body.promptEn !== undefined) fields.prompt_en = cleanSourceText(requireString(body.promptEn, '英文镜头提示词', { min: 0, max: 4000 }));
        if (body.generationSpec !== undefined) fields.generation_spec_json = JSON.stringify(body.generationSpec || {});
        if (body.plot !== undefined) fields.plot_text = cleanSourceText(requireString(body.plot, '剧情', { max: 500 }));
        if (body.shotSize !== undefined) fields.shot_size = requireString(body.shotSize, '景别', { max: 30 });
        if (body.movement !== undefined) fields.camera_movement = requireString(body.movement, '运镜', { max: 60 });
        if (body.angle !== undefined) fields.camera_angle = requireString(body.angle, '角度', { max: 40 });
        if (body.composition !== undefined) fields.composition = requireString(body.composition, '构图', { max: 60 });
        if (body.purpose !== undefined) fields.narrative_purpose = requireString(body.purpose, '目的', { max: 200 });
        if (body.focalLengthMm !== undefined) {
          const focal = Number(body.focalLengthMm);
          if (!Number.isInteger(focal) || focal < 12 || focal > 200) throw new ApiError(400, 'INVALID_FOCAL_LENGTH', '焦段必须为 12–200mm');
          fields.focal_length_mm = focal;
        }
        let updated = updateSegmentShot(db, shot.id, fields);
        const structuredChanged = ['plot', 'shotSize', 'movement', 'angle', 'composition', 'purpose', 'focalLengthMm'].some(key => body[key] !== undefined);
        if (structuredChanged && body.promptZh === undefined && updated.storyboard_plan_id) {
          const plan = getStoryboardPlan(db, updated.storyboard_plan_id);
          const bible = getLatestVisualBible(db, plan?.project_id || '');
          const editableShot = {
            plot: updated.plot_text, shotSize: updated.shot_size, movement: updated.camera_movement,
            angle: updated.camera_angle, focalLengthMm: updated.focal_length_mm,
            composition: updated.composition, purpose: updated.narrative_purpose,
          };
          const beat = plan?.director_analysis?.segments
            ?.flatMap(item => item.beats || [])
            .find(item => item.beatId === updated.beat_id);
          const generationSpec = buildGenerationSpec(editableShot, beat, bible?.content || {}, plan?.configuration || {});
          const promptZh = compileVideoPrompt(editableShot, bible?.content || {}, plan?.configuration || {}, generationSpec);
          updated = updateSegmentShot(db, shot.id, {
            prompt_zh: promptZh,
            generation_spec_json: JSON.stringify(generationSpec),
            updated_at: timestamp(),
          });
        }
        invalidateShotAssets(db, shot.id);
        if (shotPlan) updateStoryboardPlan(db, shotPlan.id, { status: 'edited', updated_at: timestamp() });
        return ok(res, { shot: segmentShotDto(updated) });
      }

      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      const status = error.status || 500;
      const code = error.code || 'INTERNAL_ERROR';
      const message = status >= 500 ? '服务暂时不可用，请稍后重试' : error.message;
      if (status >= 500) console.error(`[api] ${code}: ${error?.stack || error?.message || 'unknown error'}`);
      return json(res, status, { error: { code, message } });
    }
  };
}

function segmentShotDto(shot) {
  return {
    id: shot.id, sequence: shot.sequence, beatId: shot.beat_id, plot: shot.plot_text,
    shotSize: shot.shot_size, movement: shot.camera_movement, angle: shot.camera_angle,
    focalLengthMm: shot.focal_length_mm, composition: shot.composition, purpose: shot.narrative_purpose,
    selectionReason: shot.selection_reason, evidenceIds: shot.evidence_ids || [], promptZh: shot.prompt_zh, promptEn: shot.prompt_en,
    generationSpec: shot.generation_spec || {},
    durationMs: shot.duration_ms, duration: formatDuration(shot.duration_ms), status: shot.status,
  };
}

function updateProjectForTask(db, projectId) {
  updateProject(db, projectId, { status: 'script_processing', updated_at: timestamp() });
}
