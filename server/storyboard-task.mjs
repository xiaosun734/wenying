import { randomUUID } from 'node:crypto';
import {
  clearStoryboardArtifacts,
  createRetrievalRun,
  createSegmentShot,
  createSegmentVersion,
  createShotTransition,
  createVisualBible,
  getLatestVisualBible,
  getProject,
  getStoryboardPlan,
  getStoryboardTask,
  listSegments,
  timestamp,
  updateProject,
  updateStoryboardPlan,
  updateStoryboardTask,
} from './db.mjs';
import { RETRIEVAL_STRATEGY_VERSION } from './knowledge-retriever.mjs';
import { cleanEntityText, normalizeVisualBibleContent, visualBibleContentHash, buildGenerationSignature } from './visual-assets.mjs';

const terminalStates = new Set(['succeeded', 'failed', 'canceled']);

export class StoryboardTaskRunner {
  constructor({ db, provider, retriever, logger = console }) {
    this.db = db;
    this.provider = provider;
    this.retriever = retriever;
    this.logger = logger;
    this.queued = new Set();
  }

  enqueue(taskId) {
    if (this.queued.has(taskId)) return;
    this.queued.add(taskId);
    queueMicrotask(async () => {
      try { await this.run(taskId); } finally { this.queued.delete(taskId); }
    });
  }

  async run(taskId) {
    const task = getStoryboardTask(this.db, taskId);
    if (!task || terminalStates.has(task.status)) return;
    const project = getProject(this.db, task.project_id);
    const plan = getStoryboardPlan(this.db, task.storyboard_plan_id);
    if (!project || !plan || plan.script_version_id !== project.active_script_version_id) {
      return this.fail(task, 'STORYBOARD_TASK_INVALID', '前期策划任务与当前文案版本不匹配');
    }

    try {
      updateStoryboardTask(this.db, task.id, { status: 'running', current_step: 'preparing', progress: 3, started_at: timestamp(), updated_at: timestamp() });
      updateStoryboardPlan(this.db, plan.id, { status: 'generating', updated_at: timestamp() });
      const segments = listSegments(this.db, plan.script_version_id);
      const segmentInputs = segments.map(segment => ({
        id: segment.id,
        sequence: segment.sequence,
        title: segment.title,
        summary: segment.summary || '',
        scriptText: segment.script_text,
        durationMs: segment.duration_ms,
        targetShotCount: Math.max(1, Math.ceil(segment.duration_ms / 5000)),
      }));
      const sourceHash = buildGenerationSignature({
        kind: 'script-source',
        scriptVersionId: plan.script_version_id,
        source: segmentInputs.map(item => ({ id: item.id, sequence: item.sequence, scriptText: item.scriptText })),
      });

      updateStoryboardTask(this.db, task.id, { current_step: 'building_visual_bible', progress: 8, updated_at: timestamp() });
      let bible = getLatestVisualBible(this.db, project.id, plan.script_version_id);
      if (!bible || bible.content?.visualStyle !== plan.configuration.visualStyle) {
        const generatedContent = await this.provider.generateVisualBible({
          segments: segmentInputs,
          genre: project.genre,
          visualStyle: plan.configuration.visualStyle,
          idempotencyKey: `${task.id}:visual-bible`,
        });
        const content = { ...generatedContent, visualStyle: plan.configuration.visualStyle };
        bible = createVisualBible(this.db, { id: randomUUID(), projectId: project.id, scriptVersionId: plan.script_version_id, sourceHash, content, confirmed: false });
      }

      let directorAnalysis = plan.director_analysis;
      if (!directorAnalysis || (task.from_layer === 'director' && task.retry_count === 0)) {
        updateStoryboardTask(this.db, task.id, { current_step: 'analyzing_direction', progress: 20, updated_at: timestamp() });
        directorAnalysis = validateDirectorAnalysis(await this.provider.generateDirectorAnalysis({
          segments: segmentInputs,
          genre: project.genre,
          configuration: plan.configuration,
          idempotencyKey: `${task.id}:director`,
        }), segmentInputs);
        updateStoryboardPlan(this.db, plan.id, { director_analysis: directorAnalysis, updated_at: timestamp() });
      } else {
        directorAnalysis = validateDirectorAnalysis(directorAnalysis, segmentInputs);
      }

      let shotSelection = plan.shot_selection;
      if (task.from_layer !== 'storyboard' || !shotSelection) {
        updateStoryboardTask(this.db, task.id, { current_step: 'retrieving_knowledge', progress: 42, updated_at: timestamp() });
        const retrievalContexts = [];
        for (const analyzedSegment of directorAnalysis.segments) {
          const sourceSegment = segmentInputs.find(item => item.id === analyzedSegment.segmentId);
          for (const beat of analyzedSegment.beats) {
            const query = {
              genre: project.genre,
              durationMs: Math.min(6000, Math.max(1800, Math.round(sourceSegment.durationMs / analyzedSegment.beats.length))),
              emotion: beat.emotion,
              emotionIntensity: beat.emotionIntensity,
              action: beat.action,
              actionSpeed: beat.actionSpeed,
              sceneType: beat.sceneType,
              narrativePurpose: beat.narrativePurpose,
              subjectCount: beat.subjectCount,
              model: plan.configuration.mediaModel,
            };
            const evidence = this.retriever.retrieve(query, { topK: 6 });
            const compactEvidence = evidence.slice(0, 4).map(item => ({
              id: item.id, title: item.title, content: item.content, score: item.score,
            }));
            retrievalContexts.push({ segmentId: analyzedSegment.segmentId, beatId: beat.beatId, query, evidence: compactEvidence });
            createRetrievalRun(this.db, {
              id: randomUUID(), storyboardPlanId: plan.id, segmentId: analyzedSegment.segmentId, beatId: beat.beatId,
              query, results: evidence, strategyVersion: RETRIEVAL_STRATEGY_VERSION,
            });
          }
        }

        updateStoryboardTask(this.db, task.id, { current_step: 'selecting_shots', progress: 60, updated_at: timestamp() });
        const selectionValidation = validateShotSelection(await this.provider.generateShotSelection({
          directorAnalysis,
          retrievalContexts,
          visualBible: bible.content,
          configuration: plan.configuration,
          idempotencyKey: `${task.id}:camera`,
        }), directorAnalysis, retrievalContexts);
        shotSelection = selectionValidation.value;
        if (selectionValidation.evidenceRepairs.length) {
          this.logger.warn?.(`[storyboard-task] ${task.id} repaired evidence ids: ${JSON.stringify(selectionValidation.evidenceRepairs)}`);
        }
        updateStoryboardPlan(this.db, plan.id, {
          shot_selection: shotSelection,
          knowledge_snapshot: { ...this.retriever.snapshot(), evidenceRepairs: selectionValidation.evidenceRepairs },
          updated_at: timestamp(),
        });
      } else {
        shotSelection = validateShotSelection(shotSelection, directorAnalysis).value;
      }

      updateStoryboardTask(this.db, task.id, { current_step: 'building_storyboard', progress: 78, updated_at: timestamp() });
      const storyboard = validateStoryboard(await this.provider.generateStoryboard({
        directorAnalysis,
        shotSelection,
        visualBible: bible.content,
        configuration: plan.configuration,
        idempotencyKey: `${task.id}:storyboard`,
      }), segmentInputs);

      clearStoryboardArtifacts(this.db, plan.id);
      const bibleHash = visualBibleContentHash(bible.content);
      const createdShots = [];
      for (const storyboardSegment of storyboard.segments) {
        const segment = segments.find(item => item.id === storyboardSegment.segmentId);
        const version = createSegmentVersion(this.db, {
          id: randomUUID(), segmentId: segment.id, source: 'storyboard-v2', scriptText: segment.script_text,
          promptText: '', voiceId: plan.configuration.voiceId, visualStyle: plan.configuration.visualStyle,
          durationMs: segment.duration_ms, storyboardPlanId: plan.id,
        });
        const durations = distributeDurations(segment.duration_ms, storyboardSegment.shots);
        for (let index = 0; index < storyboardSegment.shots.length; index += 1) {
          const shot = storyboardSegment.shots[index];
          const beat = directorAnalysis.segments
            .find(item => item.segmentId === storyboardSegment.segmentId)?.beats
            .find(item => item.beatId === shot.beatId);
          const generationSpec = buildGenerationSpec(shot, beat, bible.content, plan.configuration);
          const keyframeSignature = buildGenerationSignature({
            kind: 'keyframe', visualBibleHash: bibleHash, referenceAssetIds: generationSpec.referenceAssetIds,
            promptCompilerVersion: 'keyframe-prompt-v1', prompt: generationSpec.keyframePrompt,
            width: plan.configuration.width || null, height: plan.configuration.height || null,
          });
          const motionSignature = buildGenerationSignature({
            kind: 'motion', visualBibleHash: bibleHash, referenceAssetIds: generationSpec.referenceAssetIds,
            keyframeSignature, promptCompilerVersion: 'motion-prompt-v1', prompt: generationSpec.motionPrompt,
          });
          const created = createSegmentShot(this.db, {
            id: randomUUID(), segmentVersionId: version.id, storyboardPlanId: plan.id, sequence: index + 1,
            beatId: shot.beatId, plot: shot.plot, shotSize: shot.shotSize, movement: shot.movement,
            angle: shot.angle, focalLengthMm: shot.focalLengthMm, composition: shot.composition,
            purpose: shot.purpose, durationMs: durations[index], selectionReason: shot.selectionReason,
            evidenceIds: shot.evidenceIds, generationSpec,
            keyframePromptZh: generationSpec.keyframePrompt, keyframeStatus: 'missing',
            keyframeSignature, motionSignature,
            promptZh: compileMotionPrompt(shot, bible.content, plan.configuration, generationSpec), status: 'planned',
          });
          createdShots.push({ ...created, transitionToNext: shot.transitionToNext });
        }
      }

      for (let index = 0; index < createdShots.length - 1; index += 1) {
        const current = createdShots[index];
        const next = createdShots[index + 1];
        const transition = current.transitionToNext || { type: 'cut', durationMs: 0, motivation: '保持叙事连续' };
        createShotTransition(this.db, {
          id: randomUUID(), storyboardPlanId: plan.id, fromShotId: current.id, toShotId: next.id,
          type: transition.type, durationMs: transition.durationMs, motivation: transition.motivation,
          execution: transition.execution || 'composer', evidenceIds: transition.evidenceIds || [],
        });
      }

      updateStoryboardPlan(this.db, plan.id, { status: 'review_ready', updated_at: timestamp() });
      updateProject(this.db, project.id, { status: 'storyboard_review', active_storyboard_plan_id: plan.id, updated_at: timestamp() });
      updateStoryboardTask(this.db, task.id, { status: 'succeeded', current_step: 'review_ready', progress: 100, completed_at: timestamp(), updated_at: timestamp() });
    } catch (error) {
      this.fail(task, error.code || 'STORYBOARD_FAILED', error.message || '前期策划生成失败');
      this.logger.error?.(`[storyboard-task] ${task.id} failed: ${error?.stack || error}`);
    }
  }

  fail(task, code, message) {
    const current = getStoryboardTask(this.db, task.id) || task;
    const step = stepLabel(current.current_step);
    updateStoryboardTask(this.db, task.id, { status: 'failed', current_step: current.current_step, error_code: code, error_message: `${step}：${message}`, completed_at: timestamp(), updated_at: timestamp() });
    updateStoryboardPlan(this.db, task.storyboard_plan_id, { status: 'failed', updated_at: timestamp() });
  }

  recover(taskIds) { taskIds.forEach(taskId => this.enqueue(taskId)); }
}

function stepLabel(step) {
  return ({
    preparing: '任务准备', building_visual_bible: '视觉设定', analyzing_direction: '导演分析',
    retrieving_knowledge: '知识检索', selecting_shots: '镜头选择', building_storyboard: '分镜编排',
  })[step] || '前期策划';
}

export function compileKeyframePrompt(shot, visualBible, configuration, providedSpec = null) {
  const spec = providedSpec || buildGenerationSpec(shot, null, visualBible, configuration);
  return spec.keyframePrompt || spec.motionPrompt;
}

export function compileMotionPrompt(shot, visualBible, configuration, providedSpec = null) {
  const spec = providedSpec || buildGenerationSpec(shot, null, visualBible, configuration);
  return spec.motionPrompt;
}

// Backwards-compatible name. Existing callers receive the motion-only prompt.
export function compileVideoPrompt(shot, visualBible, configuration, providedSpec = null) {
  return compileMotionPrompt(shot, visualBible, configuration, providedSpec);
}

export function buildGenerationSpec(shot, beat, visualBible = {}, configuration = {}) {
  const bible = normalizeVisualBibleContent(visualBible);
  const plot = text(shot?.plot || beat?.plot, 400);
  const rawVisibleAction = text(beat?.visibleAction, 240) || translateVisibleAction(beat?.action || plot);
  const constraints = Array.isArray(beat?.continuityConstraints) ? beat.continuityConstraints.map(String) : [];
  const mustNotShow = unique([...(beat?.mustNotShow || []), ...inferMustNotShow(constraints, plot)]);
  const audioOnlyEvents = unique([...(beat?.audioOnlyEvents || []), ...inferAudioOnlyEvents(constraints, plot)]);
  const visibleAction = sanitizeVisibleAction(rawVisibleAction, mustNotShow, audioOnlyEvents);
  const characters = selectCharacters(bible.characters, `${plot} ${visibleAction}`);
  const scenes = Array.isArray(bible.scenes) ? bible.scenes.slice(0, 2) : [];
  const props = Array.isArray(bible.props) ? bible.props.filter(prop => {
    const haystack = `${plot} ${visibleAction} ${beat?.mustShow?.join?.(' ') || ''}`;
    return haystack.includes(prop.name) || (prop.name === '电子屏' && /屏幕|时间|23|23:17|闪烁/.test(haystack));
  }).slice(0, 3) : [];
  const mustShow = unique([
    ...(beat?.mustShow || []),
    ...characters.map(character => character.name),
    ...scenes.map(scene => scene.name),
    ...props.map(prop => prop.name),
  ]).filter(Boolean);
  const protectedPositiveConcepts = unique([
    ...mustShow,
    ...(plot.includes('闪烁') ? ['闪烁'] : []),
  ]);
  const style = bible.style || configuration.visualStyle || 'cinematic';
  const postproductionElements = unique([...(beat?.postproductionElements || []), ...inferPostproductionElements(plot)]);
  const sceneDescription = scenes.map(scene => [
    scene.name,
    sanitizeReferenceDescription(cleanEntityText(scene.description), mustNotShow, audioOnlyEvents, `${plot} ${visibleAction}`),
    scene.layout ? `空间方向：${cleanEntityText(scene.layout)}` : '',
    scene.lighting ? `光线：${cleanEntityText(scene.lighting)}` : '',
    scene.colorPalette ? `色板：${cleanEntityText(scene.colorPalette)}` : '',
    scene.selectedReferenceAssetId ? `以已确认的场景母版参考图为准，空间结构、陈设位置和光线不得改变` : '',
  ].filter(Boolean).join('：')).join('；');
  const characterIdentity = characters.map(character => [
    character.name,
    character.age ? `年龄${cleanEntityText(character.age)}` : '',
    cleanEntityText(character.face),
    cleanEntityText(character.appearance) !== cleanEntityText(character.face) ? cleanEntityText(character.appearance) : '',
    cleanEntityText(character.hair) ? `发型发色：${cleanEntityText(character.hair)}` : '',
    cleanEntityText(character.body) ? `身高体型：${cleanEntityText(character.body)}` : '',
    cleanEntityText(character.costume) ? `固定服装：${cleanEntityText(character.costume)}` : '',
    character.selectedReferenceAssetId ? `以已确认的角色参考图为准，面部、发型、体型和服装保持一致` : '',
  ].filter(Boolean).join('，')).join('；');
  const propDescription = props.map(prop => [
    prop.name,
    cleanEntityText(prop.description),
    cleanEntityText(prop.material),
    cleanEntityText(prop.state),
  ].filter(Boolean).join('，')).join('；');
  const keep = unique([
    ...characters.map(character => `${character.name}的身份、面部和服装`),
    ...scenes.map(scene => `${scene.name}的空间布局、主要道具和光线`),
  ]);
  const camera = [shot?.shotSize, shot?.angle, shot?.composition, shot?.focalLengthMm ? `${shot.focalLengthMm}mm 焦段` : '']
    .filter(Boolean).join('，');
  const startState = text(beat?.startState, 200) || (visibleAction ? '动作开始前保持当前人物和场景状态' : '');
  const endState = text(beat?.endState, 200) || (visibleAction ? '动作完成后保持当前状态' : '');
  const exactTextInPost = postproductionElements.some(item => /精确.*文字|后期叠加/.test(item));
  const keyframePrompt = [
    characterIdentity,
    sceneDescription,
    propDescription,
    startState,
    camera,
    style,
    '静态关键帧：单幅完整电影画面，只确定人物身份、场景、道具、构图、光线和动作起始状态',
    '禁止上下分屏、多格漫画、拼贴、重复人物、可读字幕或可读数字',
    '不包含对白字幕，不提前出现后续事件实体',
  ].filter(Boolean).join('；');
  const environmentDynamics = audioOnlyEvents.length
    ? '保留画外声源造成的可见环境反应，但不得把画外实体具象化'
    : '按当前动作自然带动环境动态';
  const motionPrompt = [
    visibleAction,
    `动作速度：${text(beat?.actionSpeed || '中', 20)}`,
    environmentDynamics,
    [shot?.movement, '镜头运动保持单一、连续、可执行'].filter(Boolean).join('，'),
    keep.length ? `保持${keep.join('、')}不变` : '',
    '从已确认首帧开始连续运动，无镜头切换，无对白字幕',
  ].filter(Boolean).join('；');
  const sanitizedKeyframePrompt = exactTextInPost ? replaceExactScreenText(keyframePrompt) : keyframePrompt;
  const sanitizedMotionPrompt = exactTextInPost ? replaceExactScreenText(motionPrompt) : motionPrompt;
  return {
    version: 'generation-spec-v2',
    visualBibleHash: visualBibleContentHash(bible),
    plot,
    visibleSubject: characters.map(character => character.name).join('、'),
    visibleAction,
    startState,
    endState,
    actionSpeed: text(beat?.actionSpeed || '中', 20),
    mustShow,
    mustNotShow,
    audioOnlyEvents,
    postproductionElements,
    protectedPositiveConcepts,
    continuityConstraints: constraints,
    characterReferences: characters,
    sceneReferences: scenes,
    propReferences: props,
    referenceAssetIds: unique([
      ...characters.map(character => character.selectedReferenceAssetId),
      ...scenes.map(scene => scene.selectedReferenceAssetId),
      ...props.map(prop => prop.selectedReferenceAssetId),
    ]),
    keyframePrompt: sanitizedKeyframePrompt,
    motionPrompt: sanitizedMotionPrompt,
  };
}
function validateDirectorAnalysis(value, segments) {
  if (!Array.isArray(value?.segments)) throw invalid('导演分析缺少 segments');
  const normalized = value.segments.map(item => ({
    segmentId: String(item.segmentId || ''),
    beats: Array.isArray(item.beats) ? item.beats.map((beat, index) => ({
      beatId: String(beat.beatId || `${item.segmentId}-beat-${index + 1}`), plot: text(beat.plot, 300),
      emotion: text(beat.emotion, 40), emotionIntensity: clamp(Number(beat.emotionIntensity || 0.5), 0, 1),
      action: text(beat.action, 160), actionSpeed: text(beat.actionSpeed || '中', 20),
      sceneType: text(beat.sceneType, 80), narrativePurpose: text(beat.narrativePurpose, 160),
      subjectCount: Math.max(1, Number(beat.subjectCount || 1)),
      continuityConstraints: Array.isArray(beat.continuityConstraints) ? beat.continuityConstraints.map(value => text(value, 160)).filter(Boolean) : [],
      visibleAction: text(beat.visibleAction, 240), startState: text(beat.startState, 200), endState: text(beat.endState, 200),
      mustShow: Array.isArray(beat.mustShow) ? beat.mustShow.map(value => text(value, 100)).filter(Boolean) : [],
      mustNotShow: Array.isArray(beat.mustNotShow) ? beat.mustNotShow.map(value => text(value, 100)).filter(Boolean) : [],
      audioOnlyEvents: Array.isArray(beat.audioOnlyEvents) ? beat.audioOnlyEvents.map(value => text(value, 160)).filter(Boolean) : [],
      postproductionElements: Array.isArray(beat.postproductionElements) ? beat.postproductionElements.map(value => text(value, 160)).filter(Boolean) : [],
    })) : [],
  }));
  for (const segment of segments) {
    const output = normalized.find(item => item.segmentId === segment.id);
    if (!output?.beats.length) throw invalid(`片段 ${segment.id} 缺少导演分析`);
  }
  return { ...value, segments: normalized };
}

export function validateShotSelection(value, directorAnalysis, retrievalContexts = null) {
  if (!Array.isArray(value?.segments)) throw invalid('镜头选择缺少 segments');
  const allowedShotSizes = new Set(['大远景', '远景', '全景', '中景', '近景', '特写', '大特写']);
  const normalized = value.segments.map(item => ({
    segmentId: String(item.segmentId || ''),
    selections: Array.isArray(item.selections) ? item.selections.map(selection => ({
      beatId: String(selection.beatId || ''),
      shotSize: allowedShotSizes.has(selection.shotSize) ? selection.shotSize : '中景',
      angle: text(selection.angle || '平视', 40), movement: text(selection.movement || '固定镜头', 60),
      focalLengthMm: clamp(Math.round(Number(selection.focalLengthMm || 50)), 12, 200),
      composition: text(selection.composition || '三分法', 60), durationMs: clamp(Math.round(Number(selection.durationMs || 5000)), 1800, 6000),
      selectionReason: text(selection.selectionReason, 300),
      evidenceIds: Array.isArray(selection.evidenceIds) ? selection.evidenceIds.map(String).slice(0, 6) : [],
      transitionToNext: normalizeTransition(selection.transitionToNext),
    })) : [],
  }));
  const evidenceRepairs = [];
  const strictEvidence = ['true', '1', 'on', 'yes'].includes(String(process.env.RAG_EVIDENCE_STRICT || '').trim().toLowerCase());
  for (const segment of directorAnalysis.segments) {
    const selections = normalized.find(item => item.segmentId === segment.segmentId)?.selections || [];
    for (const beat of segment.beats) {
      const selection = selections.find(item => item.beatId === beat.beatId);
      if (!selection) throw invalid(`节拍 ${beat.beatId} 缺少镜头选择`);
      if (!retrievalContexts) continue;
      const evidence = retrievalContexts.find(item => item.beatId === beat.beatId)?.evidence || [];
      const allowedEvidence = new Set(evidence.map(item => item.id));
      const valid = [...new Set(selection.evidenceIds.filter(id => allowedEvidence.has(id)))];
      const dropped = [...new Set(selection.evidenceIds.filter(id => !allowedEvidence.has(id)))];
      if (!dropped.length && valid.length) continue;
      if (strictEvidence) {
        throw invalid(`节拍 ${beat.beatId} 引用了无效的知识证据：${(dropped.length ? dropped : ['无']).join('、')}`);
      }
      // 模型偶尔会把相邻节拍的 evidence id 串过来。丢弃非法 id，并在该节拍
      // 一条合法引用都没有时补回它自己的 Top 召回，避免整条策划链失败，
      // 同时保证最终落库的证据一定来自真实召回。
      const filled = valid.length ? [] : evidence.slice(0, 3).map(item => item.id);
      selection.evidenceIds = [...new Set([...valid, ...filled])];
      evidenceRepairs.push({ beatId: beat.beatId, dropped, filled });
    }
  }
  return { value: { ...value, segments: normalized }, evidenceRepairs };
}

function validateStoryboard(value, segments) {
  if (!Array.isArray(value?.segments)) throw invalid('分镜表缺少 segments');
  const normalized = value.segments.map(item => ({
    segmentId: String(item.segmentId || ''),
    shots: Array.isArray(item.shots) ? item.shots.map((shot, index) => ({
      sequence: index + 1, beatId: String(shot.beatId || ''), plot: text(shot.plot, 400),
      shotSize: text(shot.shotSize || '中景', 30), movement: text(shot.movement || '固定镜头', 60),
      angle: text(shot.angle || '平视', 40), focalLengthMm: clamp(Math.round(Number(shot.focalLengthMm || 50)), 12, 200),
      composition: text(shot.composition || '三分法', 60), purpose: text(shot.purpose, 200),
      durationMs: clamp(Math.round(Number(shot.durationMs || 5000)), 1800, 6000),
      selectionReason: text(shot.selectionReason, 300), evidenceIds: Array.isArray(shot.evidenceIds) ? shot.evidenceIds.map(String).slice(0, 6) : [],
      transitionToNext: normalizeTransition(shot.transitionToNext),
    })) : [],
  }));
  for (const segment of segments) if (!normalized.find(item => item.segmentId === segment.id)?.shots.length) throw invalid(`片段 ${segment.id} 缺少分镜`);
  return { ...value, segments: normalized };
}

function distributeDurations(totalMs, shots) {
  const weights = shots.map(shot => Math.max(1, Number(shot.durationMs || 5000)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let used = 0;
  return weights.map((weight, index) => {
    const duration = index === weights.length - 1 ? totalMs - used : Math.max(1, Math.round(totalMs * weight / totalWeight));
    used += duration;
    return duration;
  });
}

function selectCharacters(characters, content) {
  const list = Array.isArray(characters) ? characters : [];
  const selected = list.filter(character => character?.name && content.includes(character.name));
  if (selected.length) return selected;
  return list.length === 1 ? list : [];
}

function translateVisibleAction(value) {
  let result = text(value, 220);
  const replacements = [
    [/想不起来|无法想起|忘了|失忆/g, '眉头收紧，眼神游移，短暂闭眼后神情空白'],
    [/意识到|察觉到|发现/g, '视线停住，呼吸加重，身体短暂僵住'],
    [/感到害怕|恐惧|不安/g, '呼吸变急，肩背绷紧，警觉地观察四周'],
    [/怀疑|困惑/g, '微微皱眉，目光反复搜寻周围线索'],
  ];
  for (const [pattern, replacement] of replacements) result = result.replace(pattern, replacement);
  return result || '主体保持可见，以单一连续动作回应当前事件';
}

function inferMustNotShow(constraints, plot) {
  const output = [];
  for (const constraint of constraints) {
    const matches = String(constraint).matchAll(/(?:不得|不能|不要|不可)(?:明确|直接)?(?:出现|展示|显示|确认|揭示)?([^，。；]+)/g);
    for (const match of matches) if (match[1]) output.push(match[1].trim());
  }
  if (constraints.some(constraint => /女人.*(?:只|仅).*广播|(?:只|仅).*广播.*女人/.test(constraint))) output.push('女人实体');
  if (/女声|广播.*女人|女人.*广播/.test(plot)) output.push('女人实体');
  if (/传来.*列车.*轰鸣|列车.*仅以.*轰鸣/.test(`${plot} ${constraints.join(' ')}`)) output.push('列车实体');
  return unique(output);
}

function inferAudioOnlyEvents(constraints, plot) {
  const output = [];
  if (/女声|广播/.test(plot)) output.push('广播中的女声');
  if (/轰鸣|声音|脚步声|电流声/.test(plot)) output.push(plot);
  for (const constraint of constraints) if (/仅以.*(?:声音|轰鸣|广播)|通过广播/.test(constraint)) output.push(constraint);
  return unique(output);
}

function inferPostproductionElements(plot) {
  const output = [];
  if (/\d{1,2}[:：]\d{2}|电子屏.*时间/.test(plot)) output.push('精确屏幕文字由后期叠加');
  if (/闪烁/.test(plot)) output.push('电子屏闪烁可由后期增强');
  return output;
}

function sanitizeReferenceDescription(description, mustNotShow, audioOnlyEvents, currentContent) {
  const forbiddenRoots = unique(mustNotShow.flatMap(value => {
    const textValue = String(value || '');
    return ['列车', '女人', '女声', '死者', '乘客'].filter(term => textValue.includes(term));
  }));
  const audioKeywords = audioOnlyEvents.length ? ['传来', '轰鸣', '广播', '女声', '声音'] : [];
  const futureEventKeywords = ['列车', '女人', '女声', '广播'];
  return replaceExactScreenText(String(description || ''))
    .split(/[；;。，,]/)
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => !value.includes('沈砚'))
    .filter(value => !forbiddenRoots.some(term => value.includes(term)))
    .filter(value => !audioKeywords.some(term => value.includes(term)))
    .filter(value => !futureEventKeywords.some(term => value.includes(term) && !currentContent.includes(term)))
    .join('，');
}

function sanitizeVisibleAction(action, mustNotShow, audioOnlyEvents) {
  let result = String(action || '');
  const context = `${mustNotShow.join(' ')} ${audioOnlyEvents.join(' ')}`;
  if (context.includes('列车')) {
    result = result
      .replace(/(?:似乎)?有?列车[^，。；]*/g, '')
      .replace(/列车(?:正在)?接近/g, '画外轰鸣逐渐增强');
    if (/轰鸣/.test(context) && !/轰鸣/.test(result)) result = `听到画外低沉轰鸣后，${result}`;
  }
  if (/女人实体|女声.*广播|广播.*女声/.test(context)) {
    result = result.replace(/辨认出女声/g, '听见广播中的沙哑呼唤').replace(/女人/g, '画外呼唤者');
  }
  return result.replace(/[，；]{2,}/g, '，').replace(/，\s*[。；]/g, '。').trim() || '主体对画外事件作出清晰可见的反应';
}

function replaceExactScreenText(value) {
  return String(value || '')
    .replace(/\d{1,2}\s*[:：点]\s*\d{2}\s*分?/g, '无可读数字的时间显示区域')
    .replace(/二十三点十七分/g, '无可读数字的时间显示区域');
}

function unique(values) { return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]; }

function normalizeTransition(value) {
  if (!value) return null;
  const allowed = new Set(['cut', 'match_cut', 'dissolve', 'fade']);
  return { type: allowed.has(value.type) ? value.type : 'cut', durationMs: clamp(Math.round(Number(value.durationMs || 0)), 0, 1200), motivation: text(value.motivation, 200), execution: value.execution === 'in_shot' ? 'in_shot' : 'composer', evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.map(String).slice(0, 6) : [] };
}

function text(value, max) { return String(value || '').trim().slice(0, max); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function invalid(message) { return Object.assign(new Error(message), { code: 'STORYBOARD_INVALID_RESPONSE' }); }

export async function waitForStoryboardTask(runner, taskId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = getStoryboardTask(runner.db, taskId);
    if (task && terminalStates.has(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return getStoryboardTask(runner.db, taskId);
}

