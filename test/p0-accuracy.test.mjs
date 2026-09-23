import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildGenerationSpec, compileScenePlatePrompt, deriveCameraPlan, validateShotSelection } from '../server/storyboard-task.mjs';
import { sceneViewPriority } from '../server/media-task.mjs';
import {
  closeDatabase,
  createMediaAsset,
  createProject,
  createScriptVersion,
  createSegment,
  createSegmentShot,
  createSegmentVersion,
  getMediaAsset,
  getProject,
  getSegmentVersion,
  openDatabase,
} from '../server/db.mjs';
import { MediaTaskRunner, buildImageNegativePrompt, distributeShotDurations, isGenerationSpecOutdated } from '../server/media-task.mjs';
import { FfmpegComposer } from '../server/providers/composer.mjs';
import { JsonSubtitleProvider } from '../server/providers/subtitles.mjs';
import { probeMedia } from '../server/media-probe.mjs';
import { compileReferencePrompt, normalizeVisualBibleContent, referenceVariants, sceneSafeDescription } from '../server/visual-assets.mjs';

const execFileAsync = promisify(execFile);

test('builds an executable generation spec without leaking abstract narrative purpose', () => {
  const shot = {
    plot: '远处突然传来列车进站的轰鸣。',
    shotSize: '近景', angle: '平视', composition: '人物在右，隧道在左',
    focalLengthMm: 75, movement: '固定镜头', purpose: '推动未知威胁接近',
  };
  const beat = {
    action: '沈砚听见轰鸣后意识到列车正在接近。',
    continuityConstraints: ['列车仅以远处轰鸣体现', '不得确认列车外观或是否真正进站', '女人只通过广播声音出现'],
  };
  const bible = {
    characters: [{ name: '沈砚', appearance: '短黑发，清瘦脸型', costume: '黑色西装和白衬衫' }],
    scenes: [{ name: '废弃地铁站', description: '冷灰暗蓝灯光，幽暗隧道在左侧' }],
    style: '日系二维动画电影风格',
  };
  const spec = buildGenerationSpec(shot, beat, bible, { visualStyle: 'anime' });
  assert.equal(spec.version, 'generation-spec-v6');
  assert.ok(spec.mustShow.includes('沈砚'));
  assert.ok(spec.mustNotShow.includes('列车实体'));
  assert.ok(spec.mustNotShow.includes('女人实体'));
  assert.ok(spec.audioOnlyEvents.length >= 1);
  assert.match(spec.keyframePrompt, /短黑发/);
  assert.doesNotMatch(spec.motionPrompt, /短黑发|黑色西装/);
  assert.match(spec.keyframePrompt, /【最终关键帧】/);
  assert.doesNotMatch(spec.motionPrompt, /列车/);
  assert.doesNotMatch(spec.motionPrompt, /叙事目的/);
});

test('builds a three-view character sheet in the project style without plot text', () => {
  const bible = {
    style: 'anime，悬疑，深夜冷色调，废弃地铁站，忽明忽暗的日光灯，灰尘如白雾浮动。',
    visualStyle: 'anime',
    characters: [{
      name: '沈砚',
      appearance: '男性，失忆，被冷醒后从水泥地上坐起；手掌按在冰凉的黄色安全线上。其余外貌特征未明。',
      costume: '外套，胸前别着一枚白色葬礼胸花；没有手机。',
    }],
    scenes: [],
  };
  const prompt = compileReferencePrompt({
    entity: bible.characters[0], kind: 'character', visualBible: bible,
    configuration: { visualStyle: 'anime' }, variant: referenceVariants('character')[0],
  });
  assert.match(prompt, /三视图/);
  assert.match(prompt, /正面、侧面、背面/);
  assert.match(prompt, /anime/);
  assert.doesNotMatch(prompt, /废弃地铁站|灰尘/);
  assert.doesNotMatch(prompt, /未明|未交代/);
  assert.doesNotMatch(prompt, /坐起|按在/);
  assert.doesNotMatch(prompt, /没有手机/);
  assert.match(prompt, /白色葬礼胸花/);
});

test('scene reference variants are generic camera views of the same location', () => {
  const variants = referenceVariants('scene');
  assert.deepEqual(variants.map(item => item.id), ['axis-master', 'eye-level', 'side-45', 'elevated', 'interior-medium']);
  assert.ok(variants.every(item => /同一场景/.test(item.instruction)));
  assert.ok(variants.every(item => !/站台|隧道|电子屏|广播/.test(item.instruction)));
  assert.match(variants.find(item => item.id === 'eye-level').instruction, /只改变摄影机位置/);
  // 内部中景机位用来匹配分镜里的近景/中景，必须在无人物、只改机位的前提下保持空间一致。
  assert.match(variants.find(item => item.id === 'interior-medium').instruction, /中景机位/);
  assert.match(variants.find(item => item.id === 'interior-medium').instruction, /只改变摄影机位置和景别/);
});

test('reclassifies scenes and props that the model wrongly returned as characters', () => {
  const content = normalizeVisualBibleContent({
    characters: [
      {
        name: '张元', age: '18岁', face: '圆润少年脸', hair: '黑色短发', body: '清瘦',
        costume: '白色校服衬衫',
      },
      {
        name: '学校抽卡场地', description: '宽阔的室内大厅，抽卡台位于正前方',
        layout: '入口在南侧，抽卡平台在北侧', lighting: '顶部冷白光与暖金灯带',
        colorPalette: '浅灰、纯白、冷蓝', entityId: 'character_school',
        selectedReferenceAssetId: 'wrong-scene-asset', locked: true,
      },
      {
        name: '神之石', description: '掌心大小的多面体晶石，内部有彩色光纹',
        entityId: 'character_stone', selectedReferenceAssetId: 'wrong-prop-asset', locked: true,
      },
    ],
  });

  assert.deepEqual(content.characters.map(item => item.name), ['张元']);
  assert.deepEqual(content.scenes.map(item => item.name), ['学校抽卡场地']);
  assert.deepEqual(content.props.map(item => item.name), ['神之石']);
  assert.equal(content.scenes[0].entityId, 'character_school');
  assert.equal(content.props[0].entityId, 'character_stone');
  assert.equal(content.scenes[0].reclassifiedFrom, 'character');
  assert.equal(content.props[0].reclassifiedFrom, 'character');
  assert.equal(content.scenes[0].selectedReferenceAssetId, null);
  assert.equal(content.props[0].selectedReferenceAssetId, null);
  assert.equal(content.scenes[0].locked, false);

  content.scenes[0].selectedReferenceAssetId = 'new-scene-asset';
  content.scenes[0].locked = true;
  const roundTrip = normalizeVisualBibleContent(content);
  assert.equal(roundTrip.scenes[0].selectedReferenceAssetId, 'new-scene-asset');
  assert.equal(roundTrip.scenes[0].locked, true);

  const scenePrompt = compileReferencePrompt({
    entity: roundTrip.scenes[0], kind: 'scene', visualBible: roundTrip,
    variant: referenceVariants('scene')[0],
  });
  const propPrompt = compileReferencePrompt({
    entity: roundTrip.props[0], kind: 'prop', visualBible: roundTrip,
    variant: referenceVariants('prop')[0],
  });
  assert.match(scenePrompt, /场景一致性母版/);
  assert.doesNotMatch(scenePrompt, /角色全身三视图/);
  assert.match(propPrompt, /道具一致性设定/);
  assert.doesNotMatch(propPrompt, /角色全身三视图/);
});

test('keyframe canvas picks the scene view closest to the storyboard camera', () => {
  assert.equal(sceneViewPriority({ shotSize: '中景', angle: '平视' })[0], 'interior-medium');
  assert.equal(sceneViewPriority({ shotSize: '近景', angle: '平视' })[0], 'interior-medium');
  assert.equal(sceneViewPriority({ shotSize: '远景', angle: '平视' })[0], 'eye-level');
  assert.equal(sceneViewPriority({ shotSize: '全景', angle: '高机位俯拍' })[0], 'elevated');
  assert.equal(sceneViewPriority({ shotSize: '远景', angle: '侧面四分之三' })[0], 'side-45');
});

test('derives a fixed camera plan and builds a character-free scene plate prompt', () => {
  const shot = {
    plot: '沈砚站在中央祭坛前查看彩色石头。',
    shotSize: '中景',
    angle: '平视',
    composition: '主体在右三分线，祭坛位于背景中央',
    focalLengthMm: 50,
    subjectAnchor: '画面右三分线，祭坛前方',
    viewpointId: 'interior-medium',
    cameraPosition: '进入广场内部，位于沈砚左前方',
    cameraDirection: '朝向沈砚和中央祭坛',
  };
  const plan = deriveCameraPlan(shot, {});
  assert.equal(plan.viewpointId, 'interior-medium');
  assert.match(plan.cameraPosition, /广场内部/);
  assert.match(plan.subjectAnchor, /右三分线/);

  const bible = {
    style: '日式动画质感',
    scenes: [{
      name: '宗门广场',
      description: '中央祭坛，石板地面，周围宗门建筑',
      layout: '入口在南侧，祭坛在中轴中心',
      lighting: '紫蓝色灵光',
      colorPalette: '紫、蓝、银白',
      selectedReferenceAssetId: 'scene-ref-1',
    }],
    characters: [{ name: '沈砚' }],
  };
  const prompt = compileScenePlatePrompt(shot, bible, { visualStyle: 'anime' });
  assert.match(prompt, /空场景背景板/);
  assert.match(prompt, /不生成任何主要角色/);
  assert.match(prompt, /进入广场内部/);
  assert.doesNotMatch(prompt, /沈砚/);
});

test('interior camera view uses a framing-first prompt instead of the full scene bible', () => {
  const bible = {
    style: '日式动画质感',
    characters: [],
    scenes: [{
      name: '宗门广场',
      description: '大型宗门中央觉醒广场，中央有圆形祭坛，' + '细节描述'.repeat(100),
      lighting: '祭坛紫色灵力光柱是主光源，周围建筑点缀蓝紫色灵灯，' + '补充描述'.repeat(60),
      colorPalette: '深紫为主色，高亮紫为能量色，银白为建筑色',
    }],
  };
  const scene = bible.scenes[0];
  const master = referenceVariants('scene').find(item => item.id === 'axis-master');
  const interior = referenceVariants('scene').find(item => item.id === 'interior-medium');
  const masterPrompt = compileReferencePrompt({ entity: scene, kind: 'scene', visualBible: bible, variant: master });
  const interiorPrompt = compileReferencePrompt({ entity: scene, kind: 'scene', visualBible: bible, variant: interior });
  // 构图指令必须排在最前：排在后面会被整段场景设定盖掉，模型会一直交广角俯视母版。
  assert.match(interiorPrompt, /^构图与机位：同一场景的内部中景机位参考/);
  assert.match(interiorPrompt, /光照：/);
  assert.match(interiorPrompt, /色板：/);
  assert.ok(interiorPrompt.length < masterPrompt.length, '机位图提示词必须比母版提示词短');
  assert.ok(!interiorPrompt.includes('细节描述'.repeat(40)), '关键要素必须截断，不能把整段场景设定塞进来');
  assert.ok(!interiorPrompt.includes('补充描述'.repeat(30)), '光照描述必须截断');
});

test('scene descriptions drop character actions and body sensations', () => {
  const cleaned = sceneSafeDescription(
    '深夜十一点十七分，废弃地铁站站台，后脑勺贴着水泥地，寒气沿脊背上升，头顶只剩两根日光灯挣扎闪烁，站台上有冰凉的黄色安全线，沈砚躺在站台上',
    { characterNames: ['沈砚'] },
  );
  assert.match(cleaned, /废弃地铁站站台/);
  assert.match(cleaned, /日光灯/);
  assert.match(cleaned, /黄色安全线/);
  assert.doesNotMatch(cleaned, /后脑勺|脊背/);
  assert.doesNotMatch(cleaned, /沈砚/);
});

test('image negative prompts respect shot constraints and three-view sheets', () => {
  const provider = {
    imageNegativePrompt: '分格，多格漫画，重复人物，排版，可读文字，水印，低质量',
    negativePrompt: '模糊，闪烁，面部闪烁，重影',
  };
  const keyframeNegative = buildImageNegativePrompt(provider, { mustNotShow: ['列车实体'], protectedConcepts: ['闪烁'] });
  assert.doesNotMatch(keyframeNegative, /(^|，)闪烁(，|$)/);
  assert.match(keyframeNegative, /面部闪烁/);
  assert.match(keyframeNegative, /不要出现列车实体/);
  assert.match(keyframeNegative, /分格/);

  const sheetNegative = buildImageNegativePrompt(provider, { allowMultiView: true });
  assert.doesNotMatch(sheetNegative, /分格|多格漫画|重复人物/);
  assert.match(sheetNegative, /可读文字/);
});

test('repairs cross-beat evidence ids instead of failing the whole camera stage', () => {
  const directorAnalysis = {
    segments: [{ segmentId: 'seg-1', beats: [{ beatId: 'beat-01' }, { beatId: 'beat-02' }] }],
  };
  const retrievalContexts = [
    { beatId: 'beat-01', evidence: [{ id: 'a-1' }, { id: 'a-2' }, { id: 'a-3' }] },
    { beatId: 'beat-02', evidence: [{ id: 'b-1' }, { id: 'b-2' }] },
  ];
  const value = {
    segments: [{
      segmentId: 'seg-1',
      selections: [
        { beatId: 'beat-01', evidenceIds: ['a-1', 'b-1'] },
        { beatId: 'beat-02', evidenceIds: ['b-2'] },
      ],
    }],
  };
  const repaired = validateShotSelection(value, directorAnalysis, retrievalContexts);
  assert.deepEqual(repaired.value.segments[0].selections[0].evidenceIds, ['a-1']);
  assert.deepEqual(repaired.evidenceRepairs, [{ beatId: 'beat-01', dropped: ['b-1'], filled: [] }]);

  const noValidId = {
    segments: [{
      segmentId: 'seg-1',
      selections: [
        { beatId: 'beat-01', evidenceIds: ['made-up-id'] },
        { beatId: 'beat-02', evidenceIds: ['b-1'] },
      ],
    }],
  };
  const filled = validateShotSelection(noValidId, directorAnalysis, retrievalContexts);
  assert.deepEqual(filled.value.segments[0].selections[0].evidenceIds, ['a-1', 'a-2', 'a-3']);
  assert.deepEqual(filled.evidenceRepairs[0].filled, ['a-1', 'a-2', 'a-3']);

  process.env.RAG_EVIDENCE_STRICT = 'true';
  try {
    assert.throws(() => validateShotSelection(value, directorAnalysis, retrievalContexts), /无效的知识证据/);
  } finally {
    delete process.env.RAG_EVIDENCE_STRICT;
  }
});

test('uses a locked character reference without restating the whole three-view design', () => {
  const bible = {
    characters: [{
      name: '沈砚',
      appearance: '成年男性，面色苍白；具体年龄、发型与五官未交代。',
      costume: '深色正式服装；具体款式未交代。',
      age: '28 岁',
      hair: '短黑发',
      selectedReferenceAssetId: 'reference-asset-1',
    }],
    scenes: [],
    style: 'cinematic',
  };
  const spec = buildGenerationSpec({ plot: '沈砚从站台上醒来。', shotSize: '中景', angle: '平视' }, {}, bible, {});
  assert.doesNotMatch(spec.keyframePrompt, /未交代/);
  assert.doesNotMatch(spec.keyframePrompt, /28 岁|短黑发|深色正式服装/);
  assert.match(spec.keyframePrompt, /把角色参考图中的角色放进场景参考图/);
  assert.match(spec.keyframePrompt, /保持角色外观与参考图一致|与场景透视、比例、地面接触、光照和阴影一致/);
  assert.doesNotMatch(spec.keyframePrompt, /【角色】/, '有锁定参考图时不再复述整套角色设定');
  assert.ok(spec.visualBibleHash, 'generation spec must carry the visual bible hash');
});

test('recompiles generation specs that were built before or from another visual bible', () => {
  assert.equal(isGenerationSpecOutdated(null, 'bible-hash'), true);
  assert.equal(isGenerationSpecOutdated({ version: 'generation-spec-v2', visualBibleHash: 'bible-hash' }, 'bible-hash'), true);
  assert.equal(isGenerationSpecOutdated({ version: 'generation-spec-v3', visualBibleHash: 'bible-hash' }, 'bible-hash'), true);
  assert.equal(isGenerationSpecOutdated({ version: 'generation-spec-v5' }, 'bible-hash'), true);
  assert.equal(isGenerationSpecOutdated({ version: 'generation-spec-v6', visualBibleHash: 'old-hash' }, 'bible-hash'), true);
  assert.equal(isGenerationSpecOutdated({ version: 'generation-spec-v6', visualBibleHash: 'bible-hash' }, 'bible-hash'), false);
});

test('regenerates legacy empty subtitle assets so burn-in is not silently skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-subtitles-'));
  const mediaRoot = join(root, 'media');
  await mkdir(mediaRoot, { recursive: true });
  const db = await openDatabase(':memory:');
  try {
    createProject(db, { id: 'project-1', title: 'Test', genre: 'mystery', sourceText: null });
    createScriptVersion(db, {
      id: 'script-version-1', projectId: 'project-1', source: 'test', immutable: false,
      promptVersion: 'test', provider: 'test', model: 'test', cleanedText: 'test',
    });
    createSegment(db, {
      id: 'segment-1', projectId: 'project-1', scriptVersionId: 'script-version-1',
      sequence: 1, title: 'Test', scriptText: '第一句。第二句。', summary: '', durationMs: 4000,
    });
    createSegmentVersion(db, {
      id: 'segment-version-1', segmentId: 'segment-1', source: 'test', scriptText: '第一句。第二句。',
      voiceId: 'steady', visualStyle: 'cinematic', durationMs: 4000,
    });
    createMediaAsset(db, {
      id: 'subtitle-legacy', projectId: 'project-1', segmentVersionId: 'segment-version-1', type: 'subtitle',
      provider: 'local', model: 'json-subtitles-v1', objectKey: 'legacy/subtitles.json',
      durationMs: 4000, sizeBytes: 10, metadata: { format: 'json', cueCount: 0 },
    });
    const runner = new MediaTaskRunner({
      db,
      provider: { provider: 'fixture', model: 'fixture-media-v1' },
      subtitleProvider: new JsonSubtitleProvider({ mediaRoot }),
      logger: { error() {} },
    });
    const asset = await runner.ensureSubtitleAsset({
      project: getProject(db, 'project-1'),
      version: getSegmentVersion(db, 'segment-version-1'),
      existing: getMediaAsset(db, 'subtitle-legacy'),
    });
    assert.notEqual(asset.id, 'subtitle-legacy');
    assert.ok(Number(asset.metadata?.cueCount) > 0, 'new subtitle asset must carry cues');
    assert.equal(getMediaAsset(db, 'subtitle-legacy').status, 'stale');
    const srtPath = join(mediaRoot, (asset.metadata?.srtObjectKey || asset.objectKey).replace(/\.json$/i, '.srt'));
    assert.equal(existsSync(srtPath), true);
  } finally {
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  }
});

test('redistributes shot durations to the measured audio duration exactly', () => {
  const durations = distributeShotDurations(29088, [
    { duration_ms: 4699 }, { duration_ms: 4599 }, { duration_ms: 5199 },
    { duration_ms: 4999 }, { duration_ms: 3000 }, { duration_ms: 4999 }, { duration_ms: 5600 },
  ]);
  assert.equal(durations.length, 7);
  assert.equal(durations.reduce((sum, value) => sum + value, 0), 29088);
  assert.ok(durations.every(value => value > 0));
});

test('FFmpeg composer trims shots, maps audio, and reports measured output', async t => {
  try {
    await execFileAsync('ffmpeg', ['-version'], { windowsHide: true });
    await execFileAsync('ffprobe', ['-version'], { windowsHide: true });
  } catch {
    t.skip('ffmpeg/ffprobe not available');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'wenying-composer-'));
  const mediaRoot = join(root, 'media');
  await mkdir(join(mediaRoot, 'inputs'), { recursive: true });
  try {
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(mediaRoot, 'inputs', 'one.mp4')], { windowsHide: true });
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(mediaRoot, 'inputs', 'two.mp4')], { windowsHide: true });
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libmp3lame', '-y', join(mediaRoot, 'inputs', 'audio.mp3')], { windowsHide: true });

    const composer = new FfmpegComposer({ mediaRoot, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', fps: 24 });
    const result = await composer.composeSegment({
      project: { id: 'project-1' },
      segmentVersion: { id: 'version-1', segment_id: 'segment-1', duration_ms: 1500 },
      shots: [
        { id: 'shot-1', objectKey: 'inputs/one.mp4', duration_ms: 700 },
        { id: 'shot-2', objectKey: 'inputs/two.mp4', duration_ms: 800 },
      ],
      transitions: [{ from_shot_id: 'shot-1', to_shot_id: 'shot-2', type: 'dissolve', duration_ms: 200 }],
      audioAsset: { objectKey: 'inputs/audio.mp3', durationMs: 1500 },
    });
    const probe = await probeMedia(join(mediaRoot, result.objectKey));
    assert.equal(probe.hasVideo, true);
    assert.equal(probe.hasAudio, true);
    assert.ok(Math.abs(probe.durationMs - 1500) <= 100, `duration was ${probe.durationMs}ms`);
    assert.equal(result.metadata.audio, true);
    assert.equal(result.metadata.transitions[0].type, 'dissolve');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('appends one traceable JSONL record for each created media asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-metadata-log-'));
  const logPath = join(root, 'generation-metadata.jsonl');
  const db = await openDatabase(':memory:', { metadataLogPath: logPath });
  try {
    createProject(db, { id: 'project-1', title: 'Test', genre: 'mystery', sourceText: null });
    createScriptVersion(db, {
      id: 'script-version-1', projectId: 'project-1', source: 'test', immutable: false,
      promptVersion: 'test', provider: 'test', model: 'test', cleanedText: 'test',
    });
    createSegment(db, {
      id: 'segment-1', projectId: 'project-1', scriptVersionId: 'script-version-1',
      sequence: 1, title: 'Test segment', scriptText: 'test', summary: '', durationMs: 1000,
    });
    createSegmentVersion(db, {
      id: 'segment-version-1', segmentId: 'segment-1', source: 'test', scriptText: 'test',
      voiceId: 'steady', visualStyle: 'cinematic', durationMs: 1000,
    });
    createSegmentShot(db, {
      id: 'shot-1', segmentVersionId: 'segment-version-1', sequence: 1,
      promptZh: 'single male subject', generationSpec: { mustNotShow: ['woman entity'] },
    });
    createMediaAsset(db, {
      id: 'asset-1', projectId: 'project-1', segmentVersionId: 'segment-version-1', shotId: 'shot-1',
      type: 'shot_video', provider: 'comfyui', model: 'test-model', objectKey: 'projects/project-1/shot.mp4',
      durationMs: 1000, sizeBytes: 1234,
      metadata: { promptId: 'prompt-1', seed: 123, negativePrompt: 'no woman entity' },
    });

    const records = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].asset.id, 'asset-1');
    assert.equal(records[0].asset.type, 'shot_video');
    assert.equal(records[0].metadata.promptId, 'prompt-1');
    assert.equal(records[0].metadata.seed, 123);
    assert.deepEqual(records[0].shot.generationSpec.mustNotShow, ['woman entity']);
  } finally {
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  }
});
