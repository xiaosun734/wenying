import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeDatabase,
  createGenerationTask,
  createMediaAsset,
  createProject,
  createScriptVersion,
  createSegment,
  createSegmentShot,
  createSegmentVersion,
  createVisualBible,
  getGenerationTask,
  getProject,
  listMediaAssets,
  openDatabase,
  updateProject,
} from '../server/db.mjs';
import { createApi } from '../server/api.mjs';
import { MediaTaskRunner, waitForGenerationTask } from '../server/media-task.mjs';

class RecordingImageProvider {
  constructor(mediaRoot) {
    this.provider = 'fixture';
    this.model = 'fixture-image-v1';
    this.mediaRoot = mediaRoot;
    this.imageWidth = 576;
    this.imageHeight = 1024;
    this.keyframeWorkflowPath = 'fixture-image-edit';
    this.calls = [];
  }

  async generateImage(input) {
    this.calls.push(input);
    const seed = Number(input.seed || 0);
    return {
      objectKey: `fixture/edits/${input.filenamePrefix}-${seed}.png`,
      sizeBytes: 2048,
      metadata: {
        ...(input.metadata || {}),
        prompt: input.prompt,
        seed,
        startImage: Boolean(input.referenceImagePath),
        referenceImagesUsed: input.referenceImagePaths?.length || 0,
        sha256: `fixture-${input.filenamePrefix}-${seed}`,
      },
    };
  }
}

test('edits a selected reference image into new candidates without touching the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-asset-edit-reference-'));
  const db = await openDatabase(':memory:', { metadataLogPath: '' });
  try {
    createProject(db, { id: 'project-ref', title: '参考图调整', genre: '悬疑', sourceText: null });
    createMediaAsset(db, {
      id: 'character-main', projectId: 'project-ref', type: 'character_reference',
      provider: 'fixture', model: 'fixture-image-v1', objectKey: 'projects/project-ref/visual-assets/character-main.png',
      metadata: {
        entityKind: 'character', entityId: 'character_1', variantId: 'three-view',
        variantLabel: '角色三视图', candidateIndex: 1, width: 576, height: 1024, selected: true,
      },
    });
    const task = createGenerationTask(db, {
      id: 'task-ref-edit', projectId: 'project-ref', type: 'asset_edit',
      configuration: {
        sourceAssetId: 'character-main', scope: 'reference',
        prompt: '把外套改成深灰色长风衣', count: 2, denoise: 0.61, seed: 20,
      },
      provider: 'fixture', model: 'fixture-image-v1', idempotencyKey: 'ref-edit-1',
    });
    const provider = new RecordingImageProvider(root);
    const runner = new MediaTaskRunner({ db, provider, logger: { error() {} } });

    await runner.run(task.id);

    assert.equal(getGenerationTask(db, task.id).status, 'succeeded');
    assert.equal(provider.calls.length, 2);
    assert.match(provider.calls[0].prompt, /把外套改成深灰色长风衣/);
    assert.match(provider.calls[0].prompt, /保持未要求修改的主体身份/);
    assert.equal(provider.calls[0].denoise, 0.61);
    assert.equal(provider.calls[0].referenceImagePath.endsWith('character-main.png'), true);

    const created = listMediaAssets(db, { projectId: 'project-ref', type: 'character_reference' })
      .filter(asset => asset.source_asset_id === 'character-main')
      .sort((a, b) => a.metadata.candidateIndex - b.metadata.candidateIndex);
    assert.equal(created.length, 2);
    assert.equal(created[0].metadata.editedFromAssetId, 'character-main');
    assert.equal(created[0].metadata.editPrompt, '把外套改成深灰色长风衣');
    assert.equal(created[0].metadata.selected, false);
    assert.equal(created[0].metadata.candidateIndex, 2);
    assert.equal(created[1].metadata.candidateIndex, 3);
    assert.equal(listMediaAssets(db, { projectId: 'project-ref', type: 'character_reference' })
      .find(asset => asset.id === 'character-main').status, 'ready');
  } finally {
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  }
});

test('uses the selected keyframe as the edit canvas and keeps its scene and character references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-asset-edit-keyframe-'));
  const db = await openDatabase(':memory:', { metadataLogPath: '' });
  try {
    createProject(db, { id: 'project-keyframe', title: '关键帧调整', genre: '悬疑', sourceText: null });
    createScriptVersion(db, {
      id: 'script-version-1', projectId: 'project-keyframe', source: 'test', immutable: true,
      promptVersion: 'test', provider: 'test', model: 'test', cleanedText: 'test',
    });
    updateProject(db, 'project-keyframe', { active_script_version_id: 'script-version-1' });
    createSegment(db, {
      id: 'segment-1', projectId: 'project-keyframe', scriptVersionId: 'script-version-1',
      sequence: 1, title: 'Test', scriptText: 'test', summary: '', durationMs: 5000,
    });
    createSegmentVersion(db, {
      id: 'segment-version-1', segmentId: 'segment-1', source: 'test', scriptText: 'test',
      voiceId: 'magnetic', visualStyle: 'cinematic', durationMs: 5000,
    });
    createSegmentShot(db, {
      id: 'shot-1', segmentVersionId: 'segment-version-1', sequence: 1,
      promptZh: '沈砚站在站台', shotSize: '中景', angle: '平视', durationMs: 5000,
      generationSpec: { mustNotShow: ['列车实体'] },
    });
    createMediaAsset(db, {
      id: 'scene-main', projectId: 'project-keyframe', type: 'scene_reference',
      provider: 'fixture', model: 'fixture-image-v1', objectKey: 'projects/project-keyframe/visual-assets/scene-main.png',
      metadata: { entityKind: 'scene', entityId: 'scene_1', variantId: 'interior-medium', variantLabel: '内部中景机位' },
    });
    createMediaAsset(db, {
      id: 'character-main', projectId: 'project-keyframe', type: 'character_reference',
      provider: 'fixture', model: 'fixture-image-v1', objectKey: 'projects/project-keyframe/visual-assets/character-main.png',
      metadata: { entityKind: 'character', entityId: 'character_1', variantId: 'three-view', variantLabel: '角色三视图' },
    });
    createMediaAsset(db, {
      id: 'keyframe-source', projectId: 'project-keyframe', segmentVersionId: 'segment-version-1', shotId: 'shot-1',
      type: 'shot_keyframe_candidate', provider: 'fixture', model: 'fixture-image-v1',
      objectKey: 'projects/project-keyframe/visual-assets/keyframe-source.png',
      metadata: {
        shotId: 'shot-1', frameType: 'start', candidateIndex: 1, selected: true,
        referenceAssetIds: ['scene-main', 'character-main'], width: 576, height: 1024,
      },
    });
    const task = createGenerationTask(db, {
      id: 'task-keyframe-edit', projectId: 'project-keyframe', type: 'asset_edit',
      configuration: {
        sourceAssetId: 'keyframe-source', scope: 'keyframe',
        prompt: '把地面改成积水并增加冷色环境光', count: 1, seed: 7,
      },
      provider: 'fixture', model: 'fixture-image-v1', idempotencyKey: 'keyframe-edit-1',
    });
    const provider = new RecordingImageProvider(root);
    const runner = new MediaTaskRunner({ db, provider, logger: { error() {} } });

    await runner.run(task.id);

    assert.equal(getGenerationTask(db, task.id).status, 'succeeded');
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].referenceImagePath.endsWith('keyframe-source.png'), true);
    assert.ok(provider.calls[0].referenceImagePaths.length >= 1);
    assert.match(provider.calls[0].prompt, /保持当前画面构图/);
    assert.match(provider.calls[0].negativePrompt, /不要出现列车实体/);
    const created = listMediaAssets(db, { projectId: 'project-keyframe', shotId: 'shot-1' })
      .find(asset => asset.source_asset_id === 'keyframe-source');
    assert.equal(created.type, 'shot_keyframe_candidate');
    assert.equal(created.metadata.frameType, 'start');
    assert.equal(created.metadata.editedFromAssetId, 'keyframe-source');
    assert.equal(getProject(db, 'project-keyframe').status, 'draft');
  } finally {
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  }
});

test('creates an asset edit task through the API and returns the refreshed visual assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-asset-edit-api-'));
  const db = await openDatabase(':memory:', { metadataLogPath: '' });
  let server = null;
  try {
    createProject(db, { id: 'project-api', title: '接口调整', genre: '悬疑', sourceText: null });
    createMediaAsset(db, {
      id: 'scene-main', projectId: 'project-api', type: 'scene_reference',
      provider: 'fixture', model: 'fixture-image-v1', objectKey: 'projects/project-api/visual-assets/scene-main.png',
      metadata: { entityKind: 'scene', entityId: 'scene_1', variantLabel: '正面轴线母版' },
    });
    const provider = new RecordingImageProvider(root);
    const mediaRunner = new MediaTaskRunner({ db, provider, logger: { error() {} } });
    const api = createApi({
      db,
      runner: {},
      provider: {},
      mediaRunner,
      mediaProvider: provider,
      exportRunner: {},
      storyboardRunner: {},
    });
    server = createServer((req, res) => api(req, res, new URL(req.url, 'http://localhost').pathname));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/media-assets/scene-main/edit-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'api-edit-1' },
      body: JSON.stringify({ prompt: '把雨夜改成清晨薄雾', count: 1 }),
    });
    const payload = await response.json();
    assert.equal(response.status, 202, JSON.stringify(payload));
    assert.equal(payload.task.type, 'asset_edit');
    assert.equal(payload.task.configuration.sourceAssetId, 'scene-main');

    const task = await waitForGenerationTask(mediaRunner, payload.task.id);
    assert.equal(task.status, 'succeeded');
    const refreshed = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/projects/project-api`);
    const state = await refreshed.json();
    assert.equal(state.referenceAssets.some(asset => asset.sourceAssetId === 'scene-main'), true);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  }
});

test('generates a scene plate before the character keyframe and uses it as the edit canvas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-scene-plate-'));
  const db = await openDatabase(':memory:', { metadataLogPath: '' });
  try {
    createProject(db, { id: 'project-plate', title: '背景板流程', genre: '悬疑', sourceText: null });
    createScriptVersion(db, {
      id: 'script-version-plate', projectId: 'project-plate', source: 'test', immutable: true,
      promptVersion: 'test', provider: 'test', model: 'test', cleanedText: 'test',
    });
    updateProject(db, 'project-plate', { active_script_version_id: 'script-version-plate' });
    createVisualBible(db, {
      id: 'bible-plate', projectId: 'project-plate', scriptVersionId: 'script-version-plate',
      content: {
        style: '电影感写实风格',
        scenes: [{ name: '宗门广场', description: '中央祭坛与宗门建筑', selectedReferenceAssetId: 'scene-plate-ref' }],
        characters: [],
      },
    });
    createSegment(db, {
      id: 'segment-plate', projectId: 'project-plate', scriptVersionId: 'script-version-plate',
      sequence: 1, title: 'Test', scriptText: 'test', summary: '', durationMs: 5000,
    });
    createSegmentVersion(db, {
      id: 'segment-version-plate', segmentId: 'segment-plate', source: 'test', scriptText: 'test',
      voiceId: 'magnetic', visualStyle: 'cinematic', durationMs: 5000,
    });
    createSegmentShot(db, {
      id: 'shot-plate', segmentVersionId: 'segment-version-plate', sequence: 1,
      promptZh: '沈砚站在祭坛前', shotSize: '中景', angle: '平视', durationMs: 5000,
      generationSpec: {
        version: 'generation-spec-v6',
        cameraPlan: { viewpointId: 'interior-medium', cameraPosition: '进入广场内部', cameraDirection: '朝向祭坛', subjectAnchor: '画面右三分线' },
        referenceAssetIds: ['scene-plate-ref'],
      },
    });
    createMediaAsset(db, {
      id: 'scene-plate-ref', projectId: 'project-plate', type: 'scene_reference',
      provider: 'fixture', model: 'fixture-image-v1', objectKey: 'projects/project-plate/visual-assets/scene.png',
      metadata: { entityKind: 'scene', entityId: 'scene_1', variantId: 'interior-medium', variantLabel: '内部中景机位' },
    });
    const provider = new RecordingImageProvider(root);
    provider.scenePlateWorkflowPath = 'fixture-scene-plate';
    const runner = new MediaTaskRunner({ db, provider, logger: { error() {} } });
    const plateTask = createGenerationTask(db, {
      id: 'task-scene-plate', projectId: 'project-plate', type: 'scene_plate_candidates',
      configuration: { shotId: 'shot-plate', count: 1, seed: 5 },
      provider: 'fixture', model: 'fixture-image-v1', idempotencyKey: 'scene-plate-1',
    });

    await runner.run(plateTask.id);

    assert.equal(getGenerationTask(db, plateTask.id).status, 'succeeded');
    assert.equal(provider.calls[0].mode, 'scenePlate');
    assert.equal(provider.calls[0].referenceImagePath.endsWith('scene.png'), true);
    const plate = listMediaAssets(db, { projectId: 'project-plate', shotId: 'shot-plate' })
      .find(asset => asset.type === 'shot_scene_plate_candidate');
    assert.ok(plate);

    db.prepare('UPDATE segment_shots SET selected_scene_plate_asset_id = ? WHERE id = ?').run(plate.id, 'shot-plate');
    const keyframeTask = createGenerationTask(db, {
      id: 'task-plate-keyframe', projectId: 'project-plate', type: 'keyframe_candidates',
      configuration: { shotId: 'shot-plate', count: 1, seed: 6 },
      provider: 'fixture', model: 'fixture-image-v1', idempotencyKey: 'plate-keyframe-1',
    });

    await runner.run(keyframeTask.id);

    assert.equal(getGenerationTask(db, keyframeTask.id).status, 'succeeded');
    assert.match(provider.calls[1].referenceImagePath, /sceneplate_shot-plate_1-5\.png$/);
    const keyframe = listMediaAssets(db, { projectId: 'project-plate', shotId: 'shot-plate' })
      .find(asset => asset.type === 'shot_keyframe_candidate');
    assert.equal(keyframe.metadata.scenePlateAssetId, plate.id);
  } finally {
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  }
});
