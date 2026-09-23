import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createGenerationTask,
  createMediaAsset,
  createSegmentVersion,
  createSegmentShot,
  getChildGenerationTask,
  getGenerationTask,
  getMediaAsset,
  getLatestSegmentVersion,
  getLatestVisualBible,
  getVisualBible,
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
  updateMediaAsset,
  updateProject,
  updateSegmentDuration,
  updateSegmentMedia,
  updateSegmentVersion,
  updateSegmentShot,
} from './db.mjs';
import { optionalPrompt, renderPrompt } from './prompt-config.mjs';
import { acceptanceSettings, buildGenerationSpec, compileKeyframePrompt, compileMotionPrompt, compileScenePlatePrompt } from './storyboard-task.mjs';
import { REFERENCE_ASSET_TYPES, buildGenerationSignature, compileReferencePrompt, getVisualEntity, referenceVariants, visualBibleContentHash } from './visual-assets.mjs';
import { compileNegativePrompt } from './providers/comfyui.mjs';

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
      else if (task.type === 'reference_candidates') await this.runReferenceCandidatesTask(task);
      else if (task.type === 'scene_plate_candidates') await this.runScenePlateCandidatesTask(task);
      else if (task.type === 'keyframe_candidates') await this.runKeyframeCandidatesTask(task);
      else if (task.type === 'asset_edit') await this.runAssetEditTask(task);
      else if (task.type === 'compose') await this.runComposeTask(task);
    } catch (error) {
      const message = error?.message || '视频生成失败，请稍后重试';
      updateGenerationTask(this.db, task.id, {
        status: 'failed', current_step: 'failed', error_code: error?.code || 'MEDIA_TASK_FAILED',
        error_message: message, completed_at: timestamp(), updated_at: timestamp(),
      });
      if (!task.parent_task_id && ['video', 'segment', 'compose'].includes(task.type)) {
        updateProject(this.db, task.project_id, { status: 'video_failed', updated_at: timestamp() });
      }
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

  async runComposeTask(task) {
    const project = getProject(this.db, task.project_id);
    const segment = task.segment_id ? getSegment(this.db, task.segment_id) : null;
    const version = task.segment_version_id ? getSegmentVersion(this.db, task.segment_version_id) : null;
    if (!project || !segment || !version) throw Object.assign(new Error('片段合成数据不存在'), { code: 'COMPOSE_TASK_INVALID' });
    updateGenerationTask(this.db, task.id, { status: 'running', current_step: 'composing_segment', progress: 12, started_at: timestamp(), updated_at: timestamp() });
    const assets = listMediaAssets(this.db, { segmentVersionId: version.id });
    const audio = assetByType(assets, 'audio');
    const planConfiguration = version.storyboard_plan_id
      ? getStoryboardPlan(this.db, version.storyboard_plan_id)?.configuration || {}
      : {};
    const acceptance = acceptanceSettings({ ...planConfiguration, ...(task.configuration || {}) });
    const audioDurationMs = Number(audio?.durationMs || audio?.duration_ms || version.duration_ms || 0);
    const shots = listSegmentShots(this.db, version.id);
    const timelineMs = shots.reduce((sum, shot) => sum + Math.max(0, Number(shot.duration_ms || 0)), 0);
    const composeDurationMs = acceptance.enabled && timelineMs > 0
      ? Math.min(timelineMs, audioDurationMs || timelineMs)
      : audioDurationMs || Number(version.duration_ms || 0);
    const subtitleAsset = await this.ensureSubtitleAsset({
      project,
      version: {
        ...version,
        duration_ms: acceptance.enabled ? audioDurationMs : version.duration_ms,
        trim_to_ms: acceptance.enabled && composeDurationMs < audioDurationMs ? composeDurationMs : 0,
      },
      existing: assetByType(assets, 'subtitle'),
    });
    const shotAssets = shots.map(shot => ({ ...shot, objectKey: assets.find(asset => asset.shot_id === shot.id && asset.type === 'shot_video' && asset.status === 'ready')?.object_key })).filter(shot => shot.objectKey);
    if (!shotAssets.length) throw Object.assign(new Error('没有可合成的镜头视频'), { code: 'COMPOSER_SHOTS_EMPTY' });
    if (!this.composer) throw Object.assign(new Error('Composer 未配置'), { code: 'COMPOSER_NOT_CONFIGURED' });
    const transitions = version.storyboard_plan_id ? listShotTransitions(this.db, version.storyboard_plan_id) : [];
    const composeAudio = acceptance.enabled && composeDurationMs < audioDurationMs
      ? { ...audio, durationMs: composeDurationMs }
      : audio;
    const composed = await this.composer.composeSegment({
      project, segmentVersion: { ...version, duration_ms: composeDurationMs || version.duration_ms },
      shots: shotAssets, transitions, audioAsset: composeAudio, subtitleAsset,
    });
    for (const asset of assets.filter(asset => asset.type === 'video' && asset.status === 'ready')) updateMediaAsset(this.db, asset.id, { status: 'stale' });
    createMediaAsset(this.db, {
      id: randomUUID(), projectId: project.id, segmentVersionId: version.id, type: 'video',
      provider: this.composer.provider, model: this.composer.model, objectKey: composed.objectKey,
      durationMs: composed.durationMs, sizeBytes: composed.sizeBytes,
      metadata: { ...composed.metadata, mode: 'recompose', acceptanceMode: acceptance.enabled, audioDurationMs },
    });
    updateSegmentVersion(this.db, version.id, { status: 'ready', updated_at: timestamp() });
    updateSegmentMedia(this.db, segment.id, { active_version_id: version.id, media_status: 'ready', updated_at: timestamp() });
    updateGenerationTask(this.db, task.id, { status: 'succeeded', current_step: 'completed', progress: 100, completed_at: timestamp(), updated_at: timestamp() });
  }
  async runReferenceCandidatesTask(task) {
    const project = getProject(this.db, task.project_id);
    if (!project) throw Object.assign(new Error('作品不存在'), { code: 'PROJECT_NOT_FOUND' });
    const configuration = task.configuration || {};
    const bible = configuration.visualBibleId ? getVisualBible(this.db, configuration.visualBibleId) : getLatestVisualBible(this.db, project.id, project.active_script_version_id);
    if (!bible) throw Object.assign(new Error('视觉设定不存在'), { code: 'VISUAL_BIBLE_NOT_FOUND' });
    const kind = normalizeEntityKind(configuration.entityKind);
    const entity = getVisualEntity(bible.content, kind, configuration.entityId);
    if (!entity) throw Object.assign(new Error('视觉实体不存在'), { code: 'VISUAL_ENTITY_NOT_FOUND' });
    this.assertImageProvider();
    updateGenerationTask(this.db, task.id, { status: 'running', current_step: 'generating_reference_candidates', progress: 8, started_at: timestamp(), updated_at: timestamp() });
    // 场景要多一个"内部中景机位"，让关键帧能按分镜的景别挑到接近的机位图。
    const count = clampCount(configuration.count, 1, kind === 'scene' ? 5 : 4);
    // 角色只定义了一个“全身三视图”变体，需要出 4 张候选时就重复取用（换 seed）；
    // 场景有多个机位变体，则依次取用。
    const variantPool = referenceVariants(kind);
    const variants = Array.from({ length: count }, (_, index) => variantPool[index % variantPool.length]);
    const entityText = [
      entity.name, entity.appearance, entity.costume, entity.description,
      entity.layout, entity.lighting, entity.colorPalette, entity.state, entity.material,
    ].filter(Boolean).join(' ');
    const referenceNegative = buildImageNegativePrompt(this.provider, {
      allowMultiView: kind === 'character',
      protectedConcepts: /闪烁/.test(entityText) ? ['闪烁'] : [],
    });
    const bibleHash = visualBibleContentHash(bible.content);
    const seedList = [];
    // 场景候选是一组“同一空间的不同机位”。共享基础 seed 能让建筑、材质和色板
    // 比四张完全独立的文生图更稳定，variant 指令仍负责改变摄影机位置。
    const sceneViewSeed = kind === 'scene'
      ? (candidateSeed(configuration, 0) ?? Math.floor(Math.random() * 2 ** 31))
      : undefined;
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      const prompt = configuration.promptOverride
        ? `${configuration.promptOverride}；${variant.instruction}`
        : compileReferencePrompt({ entity, kind, visualBible: bible.content, variant });
      const seed = kind === 'scene' ? sceneViewSeed : candidateSeed(configuration, index);
      const signature = buildGenerationSignature({
        kind: 'reference', entityId: entity.entityId, entityKind: kind, visualBibleHash: bibleHash,
        promptCompilerVersion: 'reference-prompt-v1', prompt, workflowHash: this.provider.workflowHash || null,
        width: configuration.width || null, height: configuration.height || null, seedList: seed === undefined ? [] : [seed],
      });
      const image = await this.provider.generateImage({
        project,
        prompt,
        negativePrompt: referenceNegative,
        negativeOverride: true,
        seed,
        filenamePrefix: `reference_${safePart(kind)}_${safePart(entity.entityId)}_${variant.id}_${index + 1}`,
        width: configuration.width,
        height: configuration.height,
        metadata: { entityId: entity.entityId, entityKind: kind, variantId: variant.id, variantLabel: variant.label, visualBibleId: bible.id, visualBibleHash: bibleHash, generationTaskId: task.id, viewSetId: kind === 'scene' ? task.id : null, viewIndex: index + 1, generationSignature: signature },
      });
      seedList.push(image.metadata?.seed ?? seed ?? null);
      createMediaAsset(this.db, {
        id: randomUUID(), projectId: project.id, type: REFERENCE_ASSET_TYPES[kind],
        provider: this.provider.provider, model: this.provider.model, objectKey: image.objectKey,
        sizeBytes: image.sizeBytes, generationSignature: signature,
        metadata: { ...image.metadata, entityId: entity.entityId, entityKind: kind, variantId: variant.id, variantLabel: variant.label, visualBibleId: bible.id, visualBibleHash: bibleHash, generationTaskId: task.id, viewSetId: kind === 'scene' ? task.id : null, viewIndex: index + 1, generationSignature: signature, selected: false },
      });
      updateGenerationTask(this.db, task.id, { progress: Math.round(((index + 1) / variants.length) * 92), updated_at: timestamp() });
    }
    updateGenerationTask(this.db, task.id, { status: 'succeeded', current_step: 'completed', progress: 100, configuration_json: JSON.stringify({ ...configuration, seedList }), completed_at: timestamp(), updated_at: timestamp() });
  }

  async runScenePlateCandidatesTask(task) {
    const project = getProject(this.db, task.project_id);
    const configuration = task.configuration || {};
    const shot = configuration.shotId ? getSegmentShot(this.db, configuration.shotId) : null;
    if (!project || !shot) throw Object.assign(new Error('镜头不存在'), { code: 'SHOT_NOT_FOUND' });
    const plan = shot.storyboard_plan_id ? getStoryboardPlan(this.db, shot.storyboard_plan_id) : null;
    const bible = getLatestVisualBible(this.db, project.id, plan?.script_version_id || project.active_script_version_id);
    if (!bible) throw Object.assign(new Error('视觉设定不存在'), { code: 'VISUAL_BIBLE_NOT_FOUND' });
    this.assertImageProvider();
    updateGenerationTask(this.db, task.id, {
      status: 'running', current_step: 'generating_scene_plates', progress: 8,
      started_at: timestamp(), updated_at: timestamp(),
    });

    const count = clampCount(configuration.count, 1, 3);
    const frameType = configuration.frameType === 'end' ? 'end' : 'start';
    const beat = plan?.director_analysis?.segments?.flatMap(item => item.beats || []).find(item => item.beatId === shot.beat_id);
    const editableShot = shotToEditable(shot);
    const storedSpec = shot.generation_spec?.version ? shot.generation_spec : null;
    const specOutdated = isGenerationSpecOutdated(storedSpec, visualBibleContentHash(bible.content));
    const spec = specOutdated
      ? buildGenerationSpec(editableShot, beat, bible.content, plan?.configuration || {})
      : storedSpec;
    if (specOutdated) {
      updateSegmentShot(this.db, shot.id, {
        generation_spec_json: JSON.stringify(spec),
        keyframe_prompt_zh: compileKeyframePrompt(editableShot, bible.content, plan?.configuration || {}, spec),
        updated_at: timestamp(),
      });
    }
    const prompt = configuration.promptOverride
      ? String(configuration.promptOverride)
      : compileScenePlatePrompt(editableShot, bible.content, plan?.configuration || {}, spec);
    const referenceAssetIds = uniqueValues([...(spec.referenceAssetIds || []), ...selectedBibleReferenceIds(bible.content)]);
    const { primaryReference, alternateReferences } = selectScenePlateReferences(this.db, project.id, referenceAssetIds, editableShot);
    const referenceImagePath = referenceImagePathOf(this.provider, primaryReference);
    if (!referenceImagePath) {
      throw Object.assign(
        new Error('空场景背景板生成需要已确认的场景参考图。请先在“视觉资产”中锁定场景主参考图。'),
        { code: 'SCENE_REFERENCE_MISSING' },
      );
    }
    const referenceImagePaths = alternateReferences
      .map(asset => referenceImagePathOf(this.provider, asset))
      .filter(Boolean);
    const referenceHashes = selectedReferenceHashes(this.db, project.id, referenceAssetIds);
    const negativePrompt = [
      buildImageNegativePrompt(this.provider, {
        mustNotShow: spec.mustNotShow || [],
        protectedConcepts: spec.protectedPositiveConcepts || [],
      }),
      '主要角色特写，主角正脸，角色设定图，人物三视图',
    ].filter(Boolean).join('，');
    const seedList = [];

    for (let index = 0; index < count; index += 1) {
      const seed = candidateSeed(configuration, index);
      const signature = buildGenerationSignature({
        kind: 'scene-plate', shotId: shot.id, frameType,
        visualBibleHash: visualBibleContentHash(bible.content),
        referenceAssetHashes: referenceHashes, cameraPlan: spec.cameraPlan || null,
        promptCompilerVersion: 'scene-plate-prompt-v1', prompt,
        workflowHash: this.provider.workflowHash || null,
        seedList: seed === undefined ? [] : [seed],
      });
      const image = await this.provider.generateImage({
        project,
        prompt,
        negativePrompt,
        negativeOverride: true,
        seed,
        denoise: 1,
        mode: 'scenePlate',
        filenamePrefix: `sceneplate_${safePart(shot.id)}_${index + 1}`,
        width: configuration.width,
        height: configuration.height,
        referenceImagePath,
        referenceImagePaths,
        metadata: {
          shotId: shot.id,
          frameType,
          cameraPlan: spec.cameraPlan || null,
          referenceAssetHashes: referenceHashes,
          referenceImagePaths,
          generationSignature: signature,
        },
      });
      if (this.provider?.scenePlateWorkflowPath && !image.metadata?.startImage) {
        throw Object.assign(
          new Error('空场景背景板没有实际使用场景参考图，请检查 COMFYUI_SCENE_PLATE_* 配置。'),
          { code: 'SCENE_PLATE_REFERENCE_NOT_USED' },
        );
      }
      seedList.push(image.metadata?.seed ?? seed ?? null);
      createMediaAsset(this.db, {
        id: randomUUID(),
        projectId: project.id,
        segmentVersionId: shot.segment_version_id,
        shotId: shot.id,
        type: 'shot_scene_plate_candidate',
        provider: this.provider.provider,
        model: this.provider.model,
        objectKey: image.objectKey,
        sizeBytes: image.sizeBytes,
        generationSignature: signature,
        metadata: {
          ...(image.metadata || {}),
          shotId: shot.id,
          frameType,
          candidateIndex: index + 1,
          visualBibleId: bible.id,
          visualBibleHash: visualBibleContentHash(bible.content),
          referenceAssetIds,
          referenceAssetHashes: referenceHashes,
          cameraPlan: spec.cameraPlan || null,
          generationTaskId: task.id,
          generationSignature: signature,
          selected: false,
        },
      });
      updateGenerationTask(this.db, task.id, {
        progress: Math.round(((index + 1) / count) * 92),
        updated_at: timestamp(),
      });
    }

    updateGenerationTask(this.db, task.id, {
      status: 'succeeded', current_step: 'completed', progress: 100,
      configuration_json: JSON.stringify({ ...configuration, seedList }),
      completed_at: timestamp(), updated_at: timestamp(),
    });
  }

  async runKeyframeCandidatesTask(task) {
    const project = getProject(this.db, task.project_id);
    const configuration = task.configuration || {};
    const shot = configuration.shotId ? getSegmentShot(this.db, configuration.shotId) : null;
    if (!project || !shot) throw Object.assign(new Error('镜头不存在'), { code: 'SHOT_NOT_FOUND' });
    const plan = shot.storyboard_plan_id ? getStoryboardPlan(this.db, shot.storyboard_plan_id) : null;
    const bible = getLatestVisualBible(this.db, project.id, plan?.script_version_id || project.active_script_version_id);
    if (!bible) throw Object.assign(new Error('视觉设定不存在'), { code: 'VISUAL_BIBLE_NOT_FOUND' });
    this.assertImageProvider();
    updateGenerationTask(this.db, task.id, { status: 'running', current_step: 'generating_keyframe_candidates', progress: 8, started_at: timestamp(), updated_at: timestamp() });
    const count = clampCount(configuration.count, 1, 4);
    const frameType = configuration.frameType === 'end' ? 'end' : 'start';
    const beat = plan?.director_analysis?.segments?.flatMap(item => item.beats || []).find(item => item.beatId === shot.beat_id);
    const editableShot = shotToEditable(shot);
    const bibleHash = visualBibleContentHash(bible.content);
    const storedSpec = shot.generation_spec?.version ? shot.generation_spec : null;
    const specOutdated = isGenerationSpecOutdated(storedSpec, bibleHash);
    const spec = specOutdated
      ? buildGenerationSpec(editableShot, beat, bible.content, plan?.configuration || {})
      : storedSpec;
    const basePrompt = configuration.promptOverride
      ? String(configuration.promptOverride)
      : frameType === 'end'
        ? `${compileKeyframePrompt(editableShot, bible.content, plan?.configuration || {}, spec)}；画面表现该镜头动作结束后的稳定状态：${spec.endState || '保持主体与场景连续'}`
        : compileKeyframePrompt(editableShot, bible.content, plan?.configuration || {}, spec);
    if (specOutdated && !configuration.promptOverride) {
      // The visual bible changed after the storyboard was built: keep the shot
      // row in sync so the审核页面 shows the same prompt that was submitted.
      updateSegmentShot(this.db, shot.id, {
        generation_spec_json: JSON.stringify(spec),
        keyframe_prompt_zh: basePrompt,
        updated_at: timestamp(),
      });
    }
    const referenceAssetIds = uniqueValues([...(spec.referenceAssetIds || []), ...selectedBibleReferenceIds(bible.content)]);
    const referenceHashes = selectedReferenceHashes(this.db, project.id, referenceAssetIds);
    const selectedReferences = selectKeyframeReferenceAssets(this.db, project.id, referenceAssetIds, editableShot);
    const selectedScenePlate = shot.selected_scene_plate_asset_id ? getMediaAsset(this.db, shot.selected_scene_plate_asset_id) : null;
    const scenePlateRequired = configuration.requireScenePlate === true;
    if (scenePlateRequired && (!selectedScenePlate || selectedScenePlate.status !== 'ready')) {
      throw Object.assign(
        new Error('当前镜头缺少已确认的空场景背景板。请先生成并选择背景板，再生成角色关键帧。'),
        { code: 'SCENE_PLATE_REQUIRED' },
      );
    }
    const canvasReference = selectedScenePlate || selectedReferences.canvasReference;
    const companionReferences = selectedScenePlate
      ? [selectedReferences.canvasReference, ...selectedReferences.companionReferences]
        .filter(Boolean)
        .filter(asset => asset.id !== selectedScenePlate.id && asset.object_key !== selectedScenePlate.object_key)
        .slice(0, 2)
      : selectedReferences.companionReferences;
    const prompt = selectedScenePlate
      ? `以已选空场景背景板作为唯一构图和机位基准，只加入角色，不改变背景、空间结构、透视、光照或镜头机位。\n\n${basePrompt}`
      : basePrompt;
    // 关键帧走的是 Qwen-Image-Edit 的“编辑画布”路线：主参考图会被 ImageScale →
    // VAEEncode 接进 KSampler.latent_image，是模型真正要编辑的那张图，所以它必须是
    // 场景图（角色要被放进的地方）。角色三视图只能当参考图 2，负责身份与外观。
    const referenceImagePath = referenceImagePathOf(this.provider, canvasReference);
    const referenceImagePaths = companionReferences.map(asset => referenceImagePathOf(this.provider, asset)).filter(Boolean);
    const referenceRelationship = buildReferenceRelationshipPrompt(canvasReference, companionReferences);
    const submittedPrompt = referenceRelationship ? `${referenceRelationship}\n\n${prompt}` : prompt;
    const referenceRequired = this.keyframeReferenceRequired();
    if (referenceRequired && !referenceImagePath) {
      throw Object.assign(
        new Error('关键帧生成需要已确认的角色或场景参考图，但当前镜头没有可用参考资产。请先在“视觉资产”中锁定主参考图。'),
        { code: 'KEYFRAME_REFERENCE_MISSING' },
      );
    }
    const seedList = [];
    for (let index = 0; index < count; index += 1) {
      const seed = candidateSeed(configuration, index);
      const signature = buildGenerationSignature({
        kind: 'keyframe', frameType, shotId: shot.id, scriptVersionHash: plan?.script_version_id || null,
        generationSpecHash: buildGenerationSignature({ spec }), visualBibleHash: bibleHash, referenceAssetHashes: referenceHashes,
        scenePlateAssetId: selectedScenePlate?.id || null,
        promptCompilerVersion: 'keyframe-prompt-v4', prompt: submittedPrompt, workflowHash: this.provider.workflowHash || null,
        width: configuration.width || null, height: configuration.height || null, seedList: seed === undefined ? [] : [seed],
      });
      const image = await this.provider.generateImage({
        project,
        prompt: submittedPrompt,
        negativePrompt: buildImageNegativePrompt(this.provider, {
          mustNotShow: spec.mustNotShow || [],
          protectedConcepts: spec.protectedPositiveConcepts || [],
        }),
        negativeOverride: true,
        seed,
        filenamePrefix: `${frameType === 'end' ? 'endframe' : 'keyframe'}_${safePart(shot.id)}_${index + 1}`,
        width: configuration.width,
        height: configuration.height,
        referenceImagePath,
        referenceImagePaths,
        metadata: { shotId: shot.id, frameType, visualBibleId: bible.id, visualBibleHash: bibleHash, referenceAssetHashes: referenceHashes, referenceImagePaths, scenePlateAssetId: selectedScenePlate?.id || null, generationSignature: signature },
      });
      if (referenceRequired && !image.metadata?.startImage) {
        throw Object.assign(
          new Error('关键帧生成没有实际使用参考图，工作流已退化为文生图。请检查 COMFYUI_KEYFRAME_WORKFLOW_PATH、COMFYUI_KEYFRAME_WORKFLOW_MANIFEST_PATH 和 COMFYUI_KEYFRAME_USE_REFERENCE。'),
          { code: 'KEYFRAME_REFERENCE_NOT_USED' },
        );
      }
      seedList.push(image.metadata?.seed ?? seed ?? null);
      createMediaAsset(this.db, {
        id: randomUUID(), projectId: project.id, segmentVersionId: shot.segment_version_id, shotId: shot.id,
        type: frameType === 'end' ? 'shot_endframe_candidate' : 'shot_keyframe_candidate',
        provider: this.provider.provider, model: this.provider.model, objectKey: image.objectKey,
        sizeBytes: image.sizeBytes, generationSignature: signature,
        metadata: { ...image.metadata, shotId: shot.id, frameType, candidateIndex: index + 1, visualBibleId: bible.id, visualBibleHash: bibleHash, referenceAssetIds, referenceAssetHashes: referenceHashes, canvasReferenceAssetId: canvasReference?.id || null, primaryReferenceAssetId: canvasReference?.id || null, generationSignature: signature, selected: false },
      });
      updateGenerationTask(this.db, task.id, { progress: Math.round(((index + 1) / count) * 92), updated_at: timestamp() });
    }
    updateSegmentShot(this.db, shot.id, {
      keyframe_status: 'candidates_ready', keyframe_signature: buildGenerationSignature({ kind: 'keyframe-prompt-v4', prompt: submittedPrompt, referenceHashes, bibleHash, scenePlateAssetId: selectedScenePlate?.id || null }),
      updated_at: timestamp(),
    });
    updateGenerationTask(this.db, task.id, { status: 'succeeded', current_step: 'completed', progress: 100, configuration_json: JSON.stringify({ ...configuration, seedList }), completed_at: timestamp(), updated_at: timestamp() });
  }

  async runAssetEditTask(task) {
    const project = getProject(this.db, task.project_id);
    if (!project) throw Object.assign(new Error('作品不存在'), { code: 'PROJECT_NOT_FOUND' });
    const configuration = task.configuration || {};
    const source = configuration.sourceAssetId ? getMediaAsset(this.db, configuration.sourceAssetId) : null;
    if (!source || source.project_id !== project.id) throw Object.assign(new Error('源图片不存在'), { code: 'SOURCE_ASSET_NOT_FOUND' });
    if (source.status !== 'ready') throw Object.assign(new Error('只能调整当前可用的图片'), { code: 'SOURCE_ASSET_NOT_READY' });
    const target = assetEditTarget(source);
    if (!target) throw Object.assign(new Error('该图片类型不支持提示词调整'), { code: 'ASSET_NOT_EDITABLE' });
    const editPrompt = String(configuration.prompt || '').trim();
    if (!editPrompt) throw Object.assign(new Error('请输入需要调整的内容'), { code: 'EDIT_PROMPT_REQUIRED' });
    this.assertImageProvider();

    const sourceImagePath = referenceImagePathOf(this.provider, source);
    if (!sourceImagePath) throw Object.assign(new Error('源图片文件不可用'), { code: 'SOURCE_ASSET_FILE_MISSING' });
    const count = clampCount(configuration.count, 1, 3);
    const requestedDenoise = configuration.denoise === undefined || configuration.denoise === null || configuration.denoise === ''
      ? NaN
      : Number(configuration.denoise);
    const denoise = Number.isFinite(requestedDenoise)
      ? Math.max(0, Math.min(1, requestedDenoise))
      : Math.max(0, Math.min(1, Number(this.provider?.keyframeDenoise ?? 0.82)));
    const width = Math.max(64, Number(source.metadata?.width || this.provider?.imageWidth) || 576);
    const height = Math.max(64, Number(source.metadata?.height || this.provider?.imageHeight) || 1024);

    updateGenerationTask(this.db, task.id, {
      status: 'running', current_step: 'generating_asset_edits', progress: 8,
      started_at: timestamp(), updated_at: timestamp(),
    });

    let shot = null;
    let generationSpec = {};
    let companionReferences = [];
    let referenceAssetIds = [];
    if (target.scope === 'keyframe' || target.scope === 'scene_plate') {
      shot = source.shot_id ? getSegmentShot(this.db, source.shot_id) : null;
      if (!shot) throw Object.assign(new Error('图片对应镜头不存在'), { code: 'SHOT_NOT_FOUND' });
      const plan = shot.storyboard_plan_id ? getStoryboardPlan(this.db, shot.storyboard_plan_id) : null;
      const bible = getLatestVisualBible(this.db, project.id, plan?.script_version_id || project.active_script_version_id);
      referenceAssetIds = uniqueValues([
        ...(source.metadata?.referenceAssetIds || []),
        ...selectedBibleReferenceIds(bible?.content || {}),
      ]);
      const selectedReferences = selectKeyframeReferenceAssets(
        this.db,
        project.id,
        referenceAssetIds,
        shotToEditable(shot),
      );
      companionReferences = [selectedReferences.canvasReference, ...selectedReferences.companionReferences]
        .filter(Boolean)
        .filter(asset => asset.id !== source.id && asset.object_key !== source.object_key)
        .filter(asset => target.scope === 'scene_plate' ? asset.type === 'scene_reference' : true)
        .slice(0, 2);
      generationSpec = shot.generation_spec || {};
    }

    const prompt = compileAssetEditPrompt(source, editPrompt, target);
    const referenceImagePaths = uniqueValues(
      companionReferences.map(asset => referenceImagePathOf(this.provider, asset)).filter(Boolean),
    );
    const negativePrompt = buildImageNegativePrompt(this.provider, {
      allowMultiView: source.metadata?.entityKind === 'character',
      mustNotShow: generationSpec.mustNotShow || [],
      protectedConcepts: generationSpec.protectedPositiveConcepts || [],
    });
    const sourceHash = source.metadata?.sha256 || source.generation_signature || source.object_key;
    const referenceHashes = selectedReferenceHashes(this.db, project.id, referenceAssetIds);
    const nextCandidateIndex = nextAssetEditCandidateIndex(this.db, source, target);
    const seedList = [];

    for (let index = 0; index < count; index += 1) {
      const seed = candidateSeed(configuration, index);
      const signature = buildGenerationSignature({
        kind: 'asset-edit', sourceAssetId: source.id, sourceHash, prompt,
        targetType: target.outputType, referenceAssetHashes: referenceHashes,
        workflowHash: this.provider.workflowHash || null,
        seedList: seed === undefined ? [] : [seed],
      });
      const image = await this.provider.generateImage({
        project,
        prompt,
        negativePrompt,
        negativeOverride: true,
        seed,
        denoise,
        filenamePrefix: `edit_${safePart(target.scope)}_${safePart(source.id)}_${index + 1}`,
        width,
        height,
        referenceImagePath: sourceImagePath,
        referenceImagePaths,
        metadata: {
          editedFromAssetId: source.id,
          editPrompt,
          scope: target.scope,
          generationSignature: signature,
        },
      });
      if (this.provider?.keyframeWorkflowPath && !image.metadata?.startImage) {
        throw Object.assign(
          new Error('图片调整没有实际使用选中图，工作流已退化为文生图。请检查 COMFYUI_KEYFRAME_* 图生图配置。'),
          { code: 'ASSET_EDIT_REFERENCE_NOT_USED' },
        );
      }
      seedList.push(image.metadata?.seed ?? seed ?? null);
      createMediaAsset(this.db, {
        id: randomUUID(),
        projectId: project.id,
        segmentVersionId: source.segment_version_id || shot?.segment_version_id || null,
        shotId: shot?.id || null,
        type: target.outputType,
        provider: this.provider.provider,
        model: this.provider.model,
        objectKey: image.objectKey,
        sizeBytes: image.sizeBytes,
        generationSignature: signature,
        sourceAssetId: source.id,
        metadata: {
          ...(source.metadata || {}),
          ...(image.metadata || {}),
          shotId: shot?.id || source.metadata?.shotId || null,
          frameType: target.frameType || source.metadata?.frameType || null,
          editedFromAssetId: source.id,
          editPrompt,
          editScope: target.scope,
          candidateIndex: nextCandidateIndex + index,
          variantLabel: target.scope === 'reference'
            ? `${source.metadata?.variantLabel || '候选'} · 调整`
            : source.metadata?.variantLabel || null,
          generationTaskId: task.id,
          generationSignature: signature,
          selected: false,
        },
      });
      updateGenerationTask(this.db, task.id, {
        progress: Math.round(((index + 1) / count) * 92),
        updated_at: timestamp(),
      });
    }

    updateGenerationTask(this.db, task.id, {
      status: 'succeeded', current_step: 'completed', progress: 100,
      configuration_json: JSON.stringify({ ...configuration, seedList }),
      completed_at: timestamp(), updated_at: timestamp(),
    });
  }

  assertImageProvider() {
    if (typeof this.provider.generateImage !== 'function') {
      throw Object.assign(new Error('当前媒体 Provider 不支持关键帧图片生成'), { code: 'IMAGE_PROVIDER_NOT_CONFIGURED' });
    }
  }

  /**
   * A keyframe must be conditioned on a locked reference image. The check is
   * skipped for providers that have no keyframe img2img workflow configured
   * (for example the fixture provider used by tests).
   */
  keyframeReferenceRequired() {
    const raw = String(process.env.KEYFRAME_REFERENCE_REQUIRED ?? 'auto').trim().toLowerCase();
    if (['false', 'off', '0', 'no'].includes(raw)) return false;
    if (['true', 'on', '1', 'yes'].includes(raw)) return true;
    return Boolean(this.provider?.keyframeWorkflowPath && this.provider?.mediaRoot);
  }

  scenePlateRequired() {
    const raw = String(process.env.SCENE_PLATE_REQUIRED ?? 'auto').trim().toLowerCase();
    if (['false', 'off', '0', 'no'].includes(raw)) return false;
    if (['true', 'on', '1', 'yes'].includes(raw)) return true;
    return Boolean(this.provider?.scenePlateWorkflowPath && this.provider?.mediaRoot);
  }

  /**
   * Subtitle assets written before the cue-based generator existed carry
   * cueCount 0 and have no .srt file, which silently disables subtitle
   * burn-in during composition. Replace them instead of reusing them.
   */
  async ensureSubtitleAsset({ project, version, existing = null }) {
    if (existing && subtitleAssetUsable(existing, this.subtitleProvider?.mediaRoot)) return existing;
    if (!this.subtitleProvider) {
      if (existing) return existing;
      throw Object.assign(new Error('Subtitle provider is not configured'), { code: 'SUBTITLE_NOT_CONFIGURED' });
    }
    const subtitle = await this.subtitleProvider.createSubtitles({ project, segmentVersion: version });
    if (existing) updateMediaAsset(this.db, existing.id, { status: 'stale' });
    return createMediaAsset(this.db, {
      id: randomUUID(), projectId: project.id, segmentVersionId: version.id, type: 'subtitle',
      provider: this.subtitleProvider.provider, model: this.subtitleProvider.model,
      objectKey: subtitle.objectKey, durationMs: subtitle.durationMs, sizeBytes: subtitle.sizeBytes,
      metadata: subtitle.metadata,
    });
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
      const audioDurationMs = Number(audio?.durationMs || audio?.duration_ms || version.duration_ms);
      const acceptance = acceptanceSettings(task.configuration || {});
      let shots = await this.ensureShots(project, segment, version, task, audio);
      shots = this.ensureGenerationSpecs(project, shots);
      // 验收模式只保留前 N 个镜头，成片跟着镜头时间轴走，旁白由合成器裁切。
      const timelineMs = shots.reduce((sum, shot) => sum + Math.max(0, Number(shot.duration_ms || 0)), 0);
      const composeDurationMs = acceptance.enabled && timelineMs > 0
        ? Math.min(timelineMs, audioDurationMs || timelineMs)
        : audioDurationMs;
      const actualDurationMs = composeDurationMs;
      if (actualDurationMs > 0 && actualDurationMs !== version.duration_ms) {
        updateSegmentVersion(this.db, version.id, { duration_ms: actualDurationMs, updated_at: timestamp() });
        updateSegmentDuration(this.db, segment.id, actualDurationMs);
      }
      updateGenerationTask(this.db, task.id, { current_step: 'generating_shots', progress: 48, updated_at: timestamp() });
      const requireKeyframe = task.configuration?.keyframeRequired ?? String(process.env.KEYFRAME_REQUIRED || '').toLowerCase() === 'true';
      const currentBible = getLatestVisualBible(this.db, project.id, project.active_script_version_id);
      const currentReferenceAssetIds = selectedBibleReferenceIds(currentBible?.content || {});
      for (const shot of shots) {
        const current = getGenerationTask(this.db, task.id);
        if (current?.status === 'canceled') throw Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELED' });
        const keyframe = shot.selected_keyframe_asset_id ? getMediaAsset(this.db, shot.selected_keyframe_asset_id) : null;
        if (requireKeyframe && (!keyframe || keyframe.status !== 'ready')) {
          throw Object.assign(new Error(`镜头 ${shot.sequence} 尚未确认关键帧`), { code: 'KEYFRAME_NOT_CONFIRMED', shotId: shot.id });
        }
        const shotAssets = listMediaAssets(this.db, { segmentVersionId: version.id }).filter(item => item.shot_id === shot.id && item.type === 'shot_video' && item.status === 'ready');
        try {
          if (!shotAssets.length) {
            const startImagePath = keyframe && this.provider.mediaRoot ? resolve(this.provider.mediaRoot, keyframe.object_key) : null;
            const referenceAssetHashes = selectedReferenceHashes(this.db, project.id, currentReferenceAssetIds);
            const generationSignature = buildGenerationSignature({
              kind: 'video', scriptVersionHash: buildGenerationSignature({ script: version.script_text }),
              generationSpecHash: buildGenerationSignature({ spec: shot.generation_spec || {} }),
              visualBibleVersion: currentBible?.content_hash || null,
              referenceAssetHashes, keyframeHash: keyframe?.metadata?.sha256 || keyframe?.generation_signature || keyframe?.object_key || null,
              promptCompilerVersion: 'motion-prompt-v1', prompt: shot.generation_spec?.motionPrompt || shot.prompt_zh,
              workflowHash: this.provider.workflowHash || null,
              width: this.provider.width || null, height: this.provider.height || null, fps: this.provider.fps || null,
              frames: Math.round(Number(shot.duration_ms || 0) * Number(this.provider.fps || 24) / 1000),
            });
            const video = await this.provider.generateVideo({ project, segmentVersion: version, shot, startImagePath, keyframeAsset: keyframe, generationSignature });
            createMediaAsset(this.db, {
              id: randomUUID(), projectId: project.id, segmentVersionId: version.id, shotId: shot.id, type: 'shot_video',
              provider: this.provider.provider, model: this.provider.model, objectKey: video.objectKey,
              durationMs: video.durationMs, sizeBytes: video.sizeBytes,
              generationSignature: video.metadata?.generationSignature || generationSignature, sourceAssetId: keyframe?.id || null,
              metadata: { ...video.metadata, generationSignature: video.metadata?.generationSignature || generationSignature, keyframeAssetId: keyframe?.id || null, referenceAssetHashes },
            });
            if (video.metadata?.promptId) {
              updateSegmentShot(this.db, shot.id, { provider_job_id: video.metadata.promptId, generation_signature: video.metadata?.generationSignature || generationSignature, updated_at: timestamp() });
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
      await this.ensureSubtitleAsset({
        project,
        version: {
          ...version,
          duration_ms: acceptance.enabled ? audioDurationMs : actualDurationMs,
          trim_to_ms: acceptance.enabled && composeDurationMs < audioDurationMs ? composeDurationMs : 0,
        },
        existing: assetByType(assets, 'subtitle'),
      });

      updateGenerationTask(this.db, task.id, { current_step: 'composing_segment', progress: 82, updated_at: timestamp() });
      const allAssets = listMediaAssets(this.db, { segmentVersionId: version.id });
      const shotAssets = shots.map(shot => ({ ...shot, objectKey: allAssets.find(item => item.shot_id === shot.id && item.type === 'shot_video' && item.status === 'ready')?.objectKey })).filter(item => item.objectKey);
      const transitions = version.storyboard_plan_id ? listShotTransitions(this.db, version.storyboard_plan_id) : [];
      const subtitleAsset = assetByType(allAssets, 'subtitle');
      const composer = this.composer;
      const composeAudio = acceptance.enabled && composeDurationMs < audioDurationMs
        ? { ...audio, durationMs: composeDurationMs }
        : audio;
      const composed = composer
        ? await composer.composeSegment({ project, segmentVersion: { ...version, duration_ms: actualDurationMs }, shots: shotAssets, transitions, audioAsset: composeAudio, subtitleAsset })
        : await this.provider.generateVideo({ project, segmentVersion: version });
      if (!assetByType(listMediaAssets(this.db, { segmentVersionId: version.id }), 'video')) {
        createMediaAsset(this.db, { id: randomUUID(), projectId: project.id, segmentVersionId: version.id, type: 'video', provider: composer?.provider || this.provider.provider, model: composer?.model || this.provider.model, objectKey: composed.objectKey, durationMs: composed.durationMs, sizeBytes: composed.sizeBytes, metadata: { ...composed.metadata, acceptanceMode: acceptance.enabled, audioDurationMs } });
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
    const acceptance = acceptanceSettings(task.configuration || {});
    let shots = listSegmentShots(this.db, version.id);
    const durationMs = Number(audioAsset?.durationMs || audioAsset?.duration_ms || version.duration_ms || segment.duration_ms || 5000);
    if (shots.length) {
      const durations = acceptance.enabled
        ? capShotDurations(shots, acceptance.shotDurationMs)
        : distributeShotDurations(durationMs, shots);
      shots.forEach((shot, index) => {
        if (shot.duration_ms !== durations[index]) {
          updateSegmentShot(this.db, shot.id, { duration_ms: durations[index], updated_at: timestamp() });
        }
      });
      return listSegmentShots(this.db, version.id);
    }
    const count = acceptance.enabled
      ? Math.min(acceptance.shotLimit, Math.max(1, Math.ceil(durationMs / 5000)))
      : Math.max(1, Math.ceil(durationMs / 5000));
    let planned = null;
    if (this.textProvider?.generateShotPrompts) {
      planned = await this.textProvider.generateShotPrompts({ scriptText: version.script_text, summary: segment.summary, background: project.background || '', genre: project.genre, count, idempotencyKey: `${task.id}:shots` });
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
    const baseEach = Math.floor(durationMs / count);
    const each = acceptance.enabled ? Math.max(1, Math.min(acceptance.shotDurationMs, baseEach)) : baseEach;
    const rows = normalized.map((item, index) => createSegmentShot(this.db, {
      id: randomUUID(), segmentVersionId: version.id, sequence: item.sequence, promptZh: item.promptZh,
      durationMs: !acceptance.enabled && index === count - 1 ? durationMs - each * (count - 1) : each, status: 'ready',
    }));
    return listSegmentShots(this.db, version.id);
  }

  ensureGenerationSpecs(project, shots) {
    const bible = getLatestVisualBible(this.db, project.id, project.active_script_version_id);
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

/** 图片负面词里“禁止多视图排版”的那批词，角色三视图需要把它们去掉。 */
const MULTI_VIEW_NEGATIVE_TERMS = [
  '分格', '多格漫画', '拼贴', '上下分屏', '左右分屏', '重复人物', '排版',
  'collage', 'split screen', 'storyboard', 'comic panels', 'multiple frames',
  'contact sheet', 'diptych', 'triptych',
];

/**
 * 图片（参考图 / 关键帧）的完整负面词：
 * 全局图片负面词（三视图时去掉禁止多视图排版的那批）+ 技术质量负面词
 * （按需剔除与正向剧情冲突的词，并追加本镜头 mustNotShow）。
 */
export function buildImageNegativePrompt(provider, { allowMultiView = false, mustNotShow = [], protectedConcepts = [] } = {}) {
  const baseTerms = String(provider?.imageNegativePrompt || '')
    .split(/[，,、;；\n]+/)
    .map(value => value.trim())
    .filter(Boolean)
    .filter(term => !allowMultiView || !MULTI_VIEW_NEGATIVE_TERMS.some(banned => term.toLowerCase().includes(banned.toLowerCase())));
  const qualityTerms = compileNegativePrompt(provider?.negativePrompt || '', mustNotShow, protectedConcepts);
  return [...baseTerms, qualityTerms].filter(Boolean).join('，');
}

/**
 * A stored generation spec is only reusable while it was built from the same
 * visual bible. Specs written before visualBibleHash existed are outdated too,
 * so the first run after a visual-settings change always recompiles.
 */
export function isGenerationSpecOutdated(spec, bibleHash) {
  if (!spec || spec.version !== 'generation-spec-v6') return true;
  if (!spec.visualBibleHash) return true;
  return spec.visualBibleHash !== bibleHash;
}

/** 验收模式：把镜头时长压到可快速生成的长度，不改动旁白音频本身。 */
export function capShotDurations(shots, maxShotMs) {
  const limit = Math.max(1, Number(maxShotMs) || 5000);
  return shots.map(shot => Math.max(1, Math.min(limit, Number(shot.duration_ms || shot.durationMs) || limit)));
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
/**
 * 候选图 seed 解析：只有调用方显式传了 seed 才固定，否则返回 undefined 交给 provider 随机。
 * 不能用 Number.isInteger(Number(value)) 判断——Number(null) === 0 会把“没填”当成 seed 0，
 * 于是每次重新生成都用同一组种子（0/1/2/3），画面几乎一模一样。
 */
export function candidateSeed(configuration = {}, index = 0) {
  const value = configuration?.seed;
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.trunc(number) + index;
}

function clampCount(value, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isInteger(number) ? number : min));
}

function normalizeEntityKind(value) {
  return ['character', 'scene', 'prop'].includes(value) ? value : 'character';
}

function assetEditTarget(asset) {
  if (['character_reference', 'scene_reference', 'prop_reference'].includes(asset.type)) {
    return { scope: 'reference', outputType: asset.type };
  }
  if (asset.type === 'shot_scene_plate_candidate') {
    return { scope: 'scene_plate', outputType: 'shot_scene_plate_candidate' };
  }
  if (['shot_keyframe_candidate', 'shot_keyframe_selected', 'shot_endframe_candidate'].includes(asset.type)) {
    const frameType = asset.metadata?.frameType === 'end' || asset.type === 'shot_endframe_candidate' ? 'end' : 'start';
    return {
      scope: 'keyframe',
      outputType: frameType === 'end' ? 'shot_endframe_candidate' : 'shot_keyframe_candidate',
      frameType,
    };
  }
  return null;
}

export function compileAssetEditPrompt(source, instruction, target = assetEditTarget(source)) {
  const requested = String(instruction || '').trim();
  const preservation = target?.scope === 'scene_plate'
    ? '保持当前空场景背景板的机位、构图、建筑结构、空间位置、材质、光照方向和色板；只修改调整要求涉及的环境内容'
    : target?.scope === 'keyframe'
    ? '保持当前画面构图、镜头角度、人物身份、服装、道具位置、空间结构、透视、光照方向和色板；只修改调整要求涉及的内容'
    : '保持未要求修改的主体身份、面部、发型、体型、服装结构、场景布局、机位、光照和色板；只修改调整要求涉及的内容';
  const subject = target?.scope === 'scene_plate'
    ? '当前空场景背景板'
    : target?.scope === 'keyframe'
    ? '当前关键帧'
    : source?.metadata?.entityKind === 'scene'
      ? '当前场景参考图'
      : source?.metadata?.entityKind === 'character'
        ? '当前角色参考图'
        : '当前参考图';
  return [
    `基于选中的${subject}进行定向编辑`,
    `调整要求：${requested}`,
    preservation,
    '输出单张完整画面，不拼接对比图，不添加边框、文字、水印或说明',
  ].join('；');
}

function nextAssetEditCandidateIndex(db, source, target) {
  const siblings = target.scope === 'reference'
    ? listMediaAssets(db, { projectId: source.project_id }).filter(asset => (
      asset.type === target.outputType
      && asset.metadata?.entityKind === source.metadata?.entityKind
      && asset.metadata?.entityId === source.metadata?.entityId
    ))
    : listMediaAssets(db, { shotId: source.shot_id }).filter(asset => asset.type === target.outputType);
  const indexes = siblings
    .map(asset => Number(asset.metadata?.candidateIndex))
    .filter(Number.isFinite)
    .map(value => Math.trunc(value));
  return (indexes.length ? Math.max(...indexes) : 0) + 1;
}

function shotToEditable(shot) {
  return {
    plot: shot.plot_text,
    shotSize: shot.shot_size,
    movement: shot.camera_movement,
    angle: shot.camera_angle,
    focalLengthMm: shot.focal_length_mm,
    composition: shot.composition,
    purpose: shot.narrative_purpose,
    subjectAnchor: shot.generation_spec?.cameraPlan?.subjectAnchor || '',
    viewpointId: shot.generation_spec?.cameraPlan?.viewpointId || '',
    cameraPosition: shot.generation_spec?.cameraPlan?.cameraPosition || '',
    cameraDirection: shot.generation_spec?.cameraPlan?.cameraDirection || '',
    cameraHeight: shot.generation_spec?.cameraPlan?.cameraHeight || '',
    cameraReason: shot.generation_spec?.cameraPlan?.cameraReason || '',
  };
}

function selectedReferenceHashes(db, projectId, assetIds) {
  const ids = new Set((assetIds || []).filter(Boolean));
  if (!ids.size) return [];
  return listMediaAssets(db, { projectId })
    .filter(asset => ids.has(asset.id))
    .map(asset => ({
      assetId: asset.id,
      hash: asset.metadata?.sha256 || asset.metadata?.contentHash || asset.generation_signature || asset.object_key,
    }));
}

function safePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}
function subtitleAssetUsable(asset, mediaRoot) {
  if (!asset || asset.status !== 'ready') return false;
  if (Number(asset.metadata?.cueCount || 0) <= 0) return false;
  const srtKey = asset.metadata?.srtObjectKey || String(asset.object_key || '').replace(/\.json$/i, '.srt');
  if (!srtKey || !mediaRoot) return true;
  return existsSync(resolve(mediaRoot, srtKey));
}
function referenceImagePathOf(provider, asset) {
  return asset?.object_key && provider?.mediaRoot ? resolve(provider.mediaRoot, asset.object_key) : null;
}

/**
 * 关键帧参考图分工（对齐 Qwen-Image-Edit-2509/2511 官方模板）：
 * - 画布（startImage / referenceImagePath）：场景参考图，会被 ImageScale →
 *   VAEEncode 接进 KSampler.latent_image，是模型真正“编辑”的那张图；
 *   有多机位时优先选与镜头机位最接近的一张。
 * - 参考图 2：角色三视图，只锁定身份、脸、发型、服装、身体比例。
 * - 参考图 3：同一场景的另一机位，帮助模型理解空间结构。
 * 没有场景参考图时退回“角色当画布”的旧行为，保证老项目仍能出图。
 */
function selectKeyframeReferenceAssets(db, projectId, assetIds, shot = {}) {
  const ids = new Set((assetIds || []).filter(Boolean));
  if (!ids.size) return { canvasReference: null, companionReferences: [] };
  const readyAssets = listMediaAssets(db, { projectId }).filter(asset => asset.status === 'ready');
  const selectedAssets = readyAssets.filter(asset => ids.has(asset.id));
  const selectedScene = selectedAssets.find(asset => asset.type === 'scene_reference');
  const character = selectedAssets.find(asset => asset.type === 'character_reference') || null;
  const prop = selectedAssets.find(asset => asset.type === 'prop_reference') || null;
  const prioritizedViews = selectSceneReferenceViews(readyAssets, selectedScene, shot, null, { preferSelected: false });
  const canvasReference = prioritizedViews[0] || selectedScene || character || prop || null;
  const companionReferences = [];
  if (character && character.id !== canvasReference?.id) companionReferences.push(character);
  const alternateScene = selectSceneReferenceViews(readyAssets, selectedScene, shot, canvasReference?.id)[0];
  if (alternateScene && alternateScene.id !== canvasReference?.id) companionReferences.push(alternateScene);
  if (!companionReferences.length && prop && prop.id !== canvasReference?.id) companionReferences.push(prop);
  return { canvasReference, companionReferences: companionReferences.slice(0, 2) };
}

function selectScenePlateReferences(db, projectId, assetIds, shot = {}) {
  const ids = new Set((assetIds || []).filter(Boolean));
  if (!ids.size) return { primaryReference: null, alternateReferences: [] };
  const readyAssets = listMediaAssets(db, { projectId }).filter(asset => asset.status === 'ready');
  const selectedScene = readyAssets.find(asset => ids.has(asset.id) && asset.type === 'scene_reference') || null;
  if (!selectedScene) return { primaryReference: null, alternateReferences: [] };
  const views = selectSceneReferenceViews(readyAssets, selectedScene, shot, null, { preferSelected: true });
  const primaryReference = views.find(asset => asset.id === selectedScene.id) || selectedScene;
  const alternateReferences = views
    .filter(asset => asset.id !== primaryReference.id)
    .slice(0, 2);
  return { primaryReference, alternateReferences };
}

function selectSceneReferenceViews(assets, selectedScene, shot, primaryId, { preferSelected = true } = {}) {
  if (!selectedScene) return [];
  const entityId = selectedScene.metadata?.entityId;
  const batchId = selectedScene.metadata?.viewSetId || selectedScene.metadata?.generationTaskId || '';
  const bibleHash = selectedScene.metadata?.visualBibleHash || '';
  const related = assets.filter(asset => {
    if (asset.type !== 'scene_reference' || asset.id === primaryId) return false;
    if (asset.metadata?.entityId !== entityId) return false;
    if (batchId) return (asset.metadata?.viewSetId || asset.metadata?.generationTaskId) === batchId;
    return bibleHash ? asset.metadata?.visualBibleHash === bibleHash : asset.id === selectedScene.id;
  });
  const uniqueByVariant = new Map();
  for (const asset of related) {
    const key = asset.metadata?.variantId || asset.id;
    const existing = uniqueByVariant.get(key);
    if (!existing || String(existing.created_at || '') < String(asset.created_at || '')) uniqueByVariant.set(key, asset);
  }
  const priority = sceneViewPriority(shot);
  return [...uniqueByVariant.values()].sort((a, b) => {
    if (preferSelected) {
      if (a.id === selectedScene.id) return -1;
      if (b.id === selectedScene.id) return 1;
    }
    const aIndex = priority.indexOf(a.metadata?.variantId);
    const bIndex = priority.indexOf(b.metadata?.variantId);
    return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex);
  }).slice(0, 2);
}

/**
 * 关键帧的画布是场景参考图，而 Qwen-Image-Edit 会继承画布的构图，所以"镜头符合分镜"
 * 实际取决于"挑到哪张场景机位图"。这里按分镜的景别 + 机位给机位图排序：近景/中景优先
 * 内部中景机位，俯拍优先高机位，侧向优先四分之三机位。
 */
export function sceneViewPriority(shot = {}) {
  const size = String(shot.shotSize || '');
  const angle = `${shot.angle || ''} ${shot.composition || ''}`;
  const closeUp = /近景|特写|中近景|中景/.test(size);
  if (/俯|高机位|鸟瞰/.test(angle)) return ['elevated', 'axis-master', 'eye-level', 'side-45', 'interior-medium'];
  if (closeUp) return ['interior-medium', 'eye-level', 'side-45', 'axis-master', 'elevated'];
  if (/侧|四分之三|45/.test(angle)) return ['side-45', 'eye-level', 'interior-medium', 'axis-master', 'elevated'];
  return ['eye-level', 'axis-master', 'side-45', 'interior-medium', 'elevated'];
}

/**
 * 只声明每张图的职责。角色与场景的文字设定不在这里重复，后面的关键帧正文
 * 只描述“在这个场景里做什么、怎么拍、最终画面长什么样”。
 */
function buildReferenceRelationshipPrompt(canvasReference, companions = []) {
  const references = [canvasReference, ...companions].filter(Boolean);
  if (!references.length) return '';
  const lines = ['【Reference Image Roles / 参考图关系】'];
  references.forEach((asset, index) => {
    const number = index + 1;
    const kind = asset.metadata?.entityKind;
    const variant = asset.metadata?.variantLabel || asset.metadata?.variantId || '';
    if (index === 0 && asset.type === 'shot_scene_plate_candidate') {
      lines.push(
        'Reference Image 1: Planned scene background plate — this is the exact frame being edited.',
        'Keep its camera position, framing, composition, architecture, terrain, spatial layout, main-object positions, scale, materials, lighting direction, shadows and color palette.',
        'Only add the requested characters and their visible action. Do not replace the background or change the planned camera.',
      );
    } else if (index === 0 && kind === 'scene') {
      lines.push(
        `Reference Image 1: Environment canvas — this is the base image being edited${variant ? ` (${variant})` : ''}.`,
        'Keep its location, architecture, terrain, spatial layout, main-object positions, scale, materials, lighting atmosphere and color palette.',
        'Edit this exact place in frame: the result must remain the same location, not a different place and not a pasted-on backdrop.',
      );
    } else if (kind === 'character') {
      lines.push(
        `Reference Image ${number}: Character design reference (three-view character sheet).`,
        "Use this image only to preserve the character's identity, face, hairstyle, costume, accessories, body proportions and colors.",
        'Do not reproduce its multiple-view layout, repeated character figures, plain studio background, labels, borders or character-sheet composition.',
      );
    } else if (kind === 'scene') {
      lines.push(
        `Reference Image ${number}: Additional environment view of the same location${variant ? ` (${variant})` : ''}.`,
        'Use it to keep the architecture, terrain, spatial layout and main-object positions consistent across camera angles.',
      );
    } else {
      lines.push(`Reference Image ${number}: Prop or visual continuity reference. Preserve its design and scale; do not copy its presentation layout.`);
    }
  });
  lines.push(
    'Add the character from the character reference into the environment canvas as a newly composed subject.',
  );
  return lines.join('\n');
}
function selectedBibleReferenceIds(content) {
  const groups = [content?.characters, content?.scenes, content?.props];
  return uniqueValues(groups.flatMap(group => Array.isArray(group) ? group.map(item => item.selectedReferenceAssetId).filter(Boolean) : []));
}
function uniqueValues(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}
