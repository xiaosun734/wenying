import assert from 'node:assert/strict';
import http from 'node:http';
import test, { afterEach, beforeEach } from 'node:test';
import { openDatabase, closeDatabase } from '../server/db.mjs';
import { createApi } from '../server/api.mjs';
import { RewriteTaskRunner, waitForTask } from '../server/rewrite-task.mjs';
import { JsonSubtitleProvider } from '../server/providers/subtitles.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MediaTaskRunner, waitForGenerationTask } from '../server/media-task.mjs';
import { KnowledgeRetriever, seedKnowledgeDirectory } from '../server/knowledge-retriever.mjs';
import { StoryboardTaskRunner, waitForStoryboardTask } from '../server/storyboard-task.mjs';

let db;
let runner;
let mediaRunner;
let mediaProvider;
let storyboardRunner;
let textProvider;
let server;
let baseUrl;
let mediaRoot;

const source = length => {
  const paragraph = '沈砚在地铁站醒来。';
  return paragraph.repeat(Math.ceil(length / Array.from(paragraph).length)).slice(0, length);
};


class FixtureTextProvider {
  constructor() { this.provider = 'fixture'; this.model = 'fixture-text-v1'; }
  async rewrite({ sourceText }) {
    const paragraphs = sourceText.split(/\n{2,}/).map(item => item.trim()).filter(Boolean);
    const pieces = paragraphs.length ? paragraphs : [sourceText];
    return { cleanedText: sourceText.trim(), segments: pieces.map((text, index) => ({ sequence: index + 1, title: `Segment ${index + 1}`, scriptText: text.length > 180 ? `${text.slice(0, 178)}...` : text, summary: text.slice(0, 45) })), provider: this.provider, model: this.model, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }
  async generateShotPrompts({ count = 1, scriptText, summary }) {
    return { shots: Array.from({ length: count }, (_, index) => ({ sequence: index + 1, promptZh: `Shot ${index + 1}: ${summary || scriptText.slice(0, 40)}, continuous subject, cinematic composition` })), provider: this.provider, model: this.model, promptVersion: 'fixture-shot-v1' };
  }
  async generateVisualBible({ segments, genre, visualStyle }) {
    return { characters: [{ name: '沈砚', appearance: '短黑发，清瘦脸型', costume: '黑色正式服装' }], scenes: segments.map((item, index) => ({ name: item.title || `Scene ${index + 1}`, description: item.summary || item.scriptText.slice(0, 60) })), style: `${genre}, ${visualStyle}, consistent character and wardrobe` };
  }
  async generateDirectorAnalysis({ segments }) {
    return { segments: segments.map(segment => { const count = Math.max(1, Number(segment.targetShotCount || 1)); return { segmentId: segment.id, beats: Array.from({ length: count }, (_, index) => ({ beatId: `${segment.id}-beat-${index + 1}`, plot: `${segment.summary || segment.scriptText.slice(0, 80)} (beat ${index + 1})`, emotion: 'unease', emotionIntensity: Math.min(1, 0.55 + index * 0.05), action: 'the subject observes the environment', actionSpeed: 'slow', sceneType: 'station', narrativePurpose: index === count - 1 ? 'advance the story' : 'build tension', subjectCount: 1, continuityConstraints: [] })) }; }), provider: this.provider, model: this.model, promptVersion: 'fixture-director-v1' };
  }
  async generateShotSelection({ directorAnalysis, retrievalContexts }) {
    return { segments: directorAnalysis.segments.map(segment => ({ segmentId: segment.segmentId, selections: segment.beats.map((beat, index) => { const evidence = retrievalContexts.find(item => item.beatId === beat.beatId)?.evidence || []; return { beatId: beat.beatId, shotSize: 'medium shot', angle: 'eye level', movement: 'slow push-in', focalLengthMm: 35, composition: 'rule of thirds', durationMs: 5000, selectionReason: 'fixture camera selection', evidenceIds: evidence.slice(0, 3).map(item => item.id), transitionToNext: index === segment.beats.length - 1 ? null : { type: 'cut', durationMs: 0, motivation: 'continuity' } }; }) })), provider: this.provider, model: this.model, promptVersion: 'fixture-camera-v1' };
  }
  async generateStoryboard({ directorAnalysis, shotSelection }) {
    return { segments: shotSelection.segments.map(segment => { const directorSegment = directorAnalysis.segments.find(item => item.segmentId === segment.segmentId); return { segmentId: segment.segmentId, shots: segment.selections.map((selection, index) => { const beat = directorSegment?.beats.find(item => item.beatId === selection.beatId) || {}; return { sequence: index + 1, beatId: selection.beatId, plot: beat.plot || '', shotSize: selection.shotSize, movement: selection.movement, angle: selection.angle, focalLengthMm: selection.focalLengthMm, composition: selection.composition, purpose: beat.narrativePurpose || '', durationMs: selection.durationMs, selectionReason: selection.selectionReason, evidenceIds: selection.evidenceIds, transitionToNext: selection.transitionToNext }; }) }; }), provider: this.provider, model: this.model, promptVersion: 'fixture-storyboard-v1' };
  }
}

class RecordingTextProvider extends FixtureTextProvider {
  constructor() {
    super();
    this.calls = [];
  }
  __record(method, input) { this.calls.push({ method, input }); }
  async rewrite(input) { this.__record('rewrite', input); return super.rewrite(input); }
  async generateVisualBible(input) { this.__record('generateVisualBible', input); return super.generateVisualBible(input); }
  async generateDirectorAnalysis(input) { this.__record('generateDirectorAnalysis', input); return super.generateDirectorAnalysis(input); }
  async generateShotSelection(input) { this.__record('generateShotSelection', input); return super.generateShotSelection(input); }
  async generateStoryboard(input) { this.__record('generateStoryboard', input); return super.generateStoryboard(input); }
}

class FixtureMediaProvider {
  constructor({ mediaRoot = null } = {}) {
    this.provider = 'fixture';
    this.model = 'fixture-media-v1';
    this.videoCalls = [];
    this.imageCalls = [];
    this.mediaRoot = mediaRoot;
  }
  async generateImage(input) {
    this.imageCalls.push(input);
    const { prompt, seed, filenamePrefix = 'image' } = input;
    const resolvedSeed = Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 2 ** 31);
    return {
      objectKey: `fixture/images/${filenamePrefix}-${resolvedSeed}.png`, durationMs: 0, sizeBytes: 2048,
      metadata: { fixture: true, prompt, seed: resolvedSeed, sha256: `fixture-${filenamePrefix}` },
    };
  }
  async generateVideo(input) {
    this.videoCalls.push(input);
    const { segmentVersion, shot = null } = input;
    const objectKey = shot ? `fixture/video/${segmentVersion.id}/shots/${shot.id}.mp4` : `fixture/video/${segmentVersion.id}.mp4`;
    const durationMs = Number(shot?.duration_ms || segmentVersion.duration_ms || 1);
    return { objectKey, durationMs, sizeBytes: Math.max(1024, durationMs), metadata: { fixture: true, prompt: shot?.prompt_zh || segmentVersion.prompt_text, shotId: shot?.id || null } };
  }
}
beforeEach(async () => {
  db = await openDatabase(':memory:');
  await seedKnowledgeDirectory(db, resolve('knowledge'));
  textProvider = new FixtureTextProvider();
  runner = new RewriteTaskRunner({ db, provider: textProvider, logger: { error() {} } });
  mediaRoot = await mkdtemp(join(tmpdir(), 'wenying-fixture-media-'));  mediaProvider = new FixtureMediaProvider({ mediaRoot });
  const subtitleProvider = new JsonSubtitleProvider({ mediaRoot });
  mediaRunner = new MediaTaskRunner({ db, provider: mediaProvider, subtitleProvider, textProvider, requireAudio: false, logger: { error() {} } });
  storyboardRunner = new StoryboardTaskRunner({ db, provider: textProvider, retriever: new KnowledgeRetriever({ db }), logger: { error() {} } });
  const api = createApi({ db, runner, provider: textProvider, mediaRunner, mediaProvider, storyboardRunner });
  server = http.createServer((req, res) => api(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDatabase(db);
  await rm(mediaRoot, { recursive: true, force: true });
});

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

async function createProject(overrides = {}) {
  const { response, body } = await request('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: '测试作品',
      genre: '悬疑',
      sourceText: source(600),
      copyrightConfirmed: true,
      ...overrides,
    }),
  });
  assert.equal(response.status, 201);
  return body.project;
}

async function createReadyScript() {
  const project = await createProject();
  const { response, body } = await request(`/projects/${project.id}/script-tasks`, {
    method: 'POST',
    headers: { 'idempotency-key': `test-${project.id}` },
  });
  assert.equal(response.status, 202);
  const task = await waitForTask(runner, body.task.id);
  assert.equal(task.status, 'succeeded', task.error_message || task.error_code || 'keyframe task failed');
  const state = await request(`/projects/${project.id}`);
  return { project, task, state: state.body };
}

test('rejects invalid source length, copyright confirmation, and reviewed content', async () => {
  let result = await request('/projects', {
    method: 'POST',
    body: JSON.stringify({ title: '短文', genre: '悬疑', sourceText: '测试正文', copyrightConfirmed: true }),
  });
  assert.equal(result.response.status, 201);

  result = await request('/projects', {
    method: 'POST',
    body: JSON.stringify({ title: '无授权', genre: '悬疑', sourceText: source(500), copyrightConfirmed: false }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, 'COPYRIGHT_REQUIRED');

  result = await request('/projects', {
    method: 'POST',
    body: JSON.stringify({ title: '过长', genre: '悬疑', sourceText: source(30001), copyrightConfirmed: true }),
  });
  assert.equal(result.response.status, 400);

  result = await request('/projects', {
    method: 'POST',
    body: JSON.stringify({ title: '审核', genre: '悬疑', sourceText: `${source(500)}儿童色情`, copyrightConfirmed: true }),
  });
  assert.equal(result.response.status, 422);
  assert.equal(result.body.error.code, 'CONTENT_REVIEW_REJECTED');
});

test('creates one idempotent rewrite task and persists structured segments', async () => {
  const project = await createProject();
  const headers = { 'idempotency-key': 'same-request-key' };
  const first = await request(`/projects/${project.id}/script-tasks`, { method: 'POST', headers });
  const second = await request(`/projects/${project.id}/script-tasks`, { method: 'POST', headers });
  assert.equal(first.response.status, 202);
  assert.ok(second.body.task, JSON.stringify(second.body));
  assert.equal(second.body.task.id, first.body.task.id);

  const task = await waitForTask(runner, first.body.task.id);
  assert.equal(task.status, 'succeeded');
  const state = await request(`/projects/${project.id}`);
  assert.equal(state.body.project.status, 'script_ready');
  assert.ok(state.body.version.id);
  assert.ok(state.body.segments.length > 0);
  assert.equal(state.body.segments[0].sequence, 1);
  assert.ok(state.body.segments[0].durationMs > 0);
});

test('allows short source text to complete the rewrite task', async () => {
  const project = await createProject({ sourceText: '深夜，门外响起三次敲门声。她打开门，却看见十年前的自己。' });
  const started = await request(`/projects/${project.id}/script-tasks`, {
    method: 'POST',
    headers: { 'idempotency-key': `short-${project.id}` },
  });
  assert.equal(started.response.status, 202);
  const task = await waitForTask(runner, started.body.task.id);
  assert.equal(task.status, 'succeeded');
});

test('keeps tiny test input to one segment and one shot', async () => {
  const project = await createProject({ sourceText: '门外响起三次敲门声。' });
  const started = await request(`/projects/${project.id}/script-tasks`, {
    method: 'POST',
    headers: { 'idempotency-key': `tiny-${project.id}` },
  });
  const task = await waitForTask(runner, started.body.task.id);
  assert.equal(task.status, 'succeeded');

  const ready = await request(`/projects/${project.id}`);
  assert.equal(ready.body.segments.length, 1);
  const confirmed = await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  assert.equal(confirmed.response.status, 200);
  const storyboard = await request(`/projects/${project.id}/storyboard-tasks`, { method: 'POST' });
  assert.equal(storyboard.response.status, 202);
  const storyboardTask = await waitForStoryboardTask(storyboardRunner, storyboard.body.task.id);
  assert.equal(storyboardTask.status, 'succeeded');
  const planned = await request(`/projects/${project.id}`);
  assert.equal(planned.body.segments.length, 1);
  assert.equal(planned.body.segments[0].shots.length, 1);
});

test('carries the project background into every planning provider call', async () => {
  const recording = new RecordingTextProvider();
  runner.provider = recording;
  storyboardRunner.provider = recording;
  const background = '主角沈砚，28 岁刑警，左眉有旧疤；故事发生在常年阴雨的南方小城。';
  const { body } = await request('/projects', {
    method: 'POST',
    body: JSON.stringify({ title: '背景设定', genre: '悬疑', background, sourceText: source(400), copyrightConfirmed: true }),
  });
  assert.equal(body.project.background, background);

  const rewriteTask = await request(`/projects/${body.project.id}/script-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `background-rewrite-${body.project.id}` },
  });
  const rewritten = await waitForTask(runner, rewriteTask.body.task.id);
  assert.equal(rewritten.status, 'succeeded');
  const rewriteCall = recording.calls.find(call => call.method === 'rewrite');
  assert.ok(rewriteCall, 'rewrite should have been called');
  assert.equal(rewriteCall.input.background, background);

  const confirmed = await request(`/projects/${body.project.id}/script/confirm`, { method: 'POST' });
  assert.equal(confirmed.response.status, 200);
  const storyboardTask = await request(`/projects/${body.project.id}/storyboard-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `background-storyboard-${body.project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic', ratio: '9:16' }),
  });
  const planned = await waitForStoryboardTask(storyboardRunner, storyboardTask.body.task.id);
  assert.equal(planned.status, 'succeeded');

  const planning = recording.calls.filter(call => call.method !== 'rewrite');
  for (const method of ['generateVisualBible', 'generateDirectorAnalysis', 'generateShotSelection', 'generateStoryboard']) {
    const call = planning.find(item => item.method === method);
    assert.ok(call, method + ' should have been called');
    assert.equal(call.input.background, background, method + ' should receive the project background');
  }
  const state = await request(`/projects/${body.project.id}`);
  assert.ok(state.body.visualBible.content.backgroundHash.length > 0);
});

test('regenerates the visual bible when the background changes', async () => {
  const recording = new RecordingTextProvider();
  runner.provider = recording;
  storyboardRunner.provider = recording;
  const { body } = await request('/projects', {
    method: 'POST',
    body: JSON.stringify({ title: '背景变更', genre: '悬疑', background: '旧背景', sourceText: source(300), copyrightConfirmed: true }),
  });
  const rewriteTask = await request(`/projects/${body.project.id}/script-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `background-change-rewrite-${body.project.id}` },
  });
  await waitForTask(runner, rewriteTask.body.task.id);
  await request(`/projects/${body.project.id}/script/confirm`, { method: 'POST' });
  const firstTask = await request(`/projects/${body.project.id}/storyboard-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `background-change-first-${body.project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic', ratio: '9:16' }),
  });
  await waitForStoryboardTask(storyboardRunner, firstTask.body.task.id);
  const firstBible = await request(`/projects/${body.project.id}`);
  const firstHash = firstBible.body.visualBible.content.backgroundHash;

  db.prepare('UPDATE projects SET background = ? WHERE id = ?').run('新背景', body.project.id);
  const secondTask = await request(`/projects/${body.project.id}/storyboard-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `background-change-second-${body.project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic', ratio: '9:16' }),
  });
  await waitForStoryboardTask(storyboardRunner, secondTask.body.task.id);
  const secondBible = await request(`/projects/${body.project.id}`);
  assert.notEqual(secondBible.body.visualBible.content.backgroundHash, firstHash);
  const bibleCalls = recording.calls.filter(call => call.method === 'generateVisualBible');
  assert.equal(bibleCalls.length, 2);
  assert.equal(bibleCalls[1].input.background, '新背景');
});

test('regenerates a derived storyboard plan from a downstream layer', async () => {
  const { project } = await createReadyScript();
  await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  const first = await request(`/projects/${project.id}/storyboard-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `storyboard-${project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic', ratio: '9:16' }),
  });
  await waitForStoryboardTask(storyboardRunner, first.body.task.id);
  const originalState = await request(`/projects/${project.id}`);
  const originalPlan = originalState.body.storyboardPlan;
  const regenerated = await request(`/storyboard-plans/${originalPlan.id}/regenerate`, {
    method: 'POST', headers: { 'idempotency-key': `storyboard-derived-${project.id}` },
    body: JSON.stringify({ fromLayer: 'storyboard' }),
  });
  assert.equal(regenerated.response.status, 202);
  const regeneratedTask = await waitForStoryboardTask(storyboardRunner, regenerated.body.task.id);
  assert.equal(regeneratedTask.status, 'succeeded');
  const derivedState = await request(`/projects/${project.id}`);
  assert.equal(derivedState.body.storyboardPlan.basePlanId, originalPlan.id);
  assert.notEqual(derivedState.body.storyboardPlan.id, originalPlan.id);
  assert.deepEqual(derivedState.body.storyboardPlan.directorAnalysis, originalPlan.directorAnalysis);
  assert.deepEqual(derivedState.body.storyboardPlan.shotSelection, originalPlan.shotSelection);
});

test('reuses completed director analysis when retrying a failed camera stage', async () => {
  let directorCalls = 0;
  let cameraCalls = 0;
  const generateDirector = textProvider.generateDirectorAnalysis.bind(textProvider);
  const generateCamera = textProvider.generateShotSelection.bind(textProvider);
  textProvider.generateDirectorAnalysis = async input => { directorCalls += 1; return generateDirector(input); };
  textProvider.generateShotSelection = async input => {
    cameraCalls += 1;
    if (cameraCalls === 1) throw Object.assign(new Error('临时网络异常'), { code: 'SCRIPT_PROVIDER_NETWORK', retryable: true });
    return generateCamera(input);
  };

  const { project } = await createReadyScript();
  await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  const started = await request(`/projects/${project.id}/storyboard-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `checkpoint-${project.id}` },
  });
  const failed = await waitForStoryboardTask(storyboardRunner, started.body.task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error_message, /^镜头选择：/);
  const retried = await request(`/storyboard-tasks/${failed.id}/retry`, { method: 'POST' });
  assert.equal(retried.response.status, 202, JSON.stringify(retried.body));
  const completed = await waitForStoryboardTask(storyboardRunner, retried.body.task.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(directorCalls, 1);
  assert.equal(cameraCalls, 2);
});

test('saves drafts with optimistic revisions and confirms an immutable snapshot', async () => {
  const { project, state } = await createReadyScript();
  const segment = state.segments[0];
  const save = await request(`/segments/${segment.id}/draft`, {
    method: 'PATCH',
    body: JSON.stringify({ scriptText: `${segment.scriptText} 已修改`, revision: segment.revision }),
  });
  assert.equal(save.response.status, 200);
  assert.equal(save.body.segment.revision, segment.revision + 1);

  const conflict = await request(`/segments/${segment.id}/draft`, {
    method: 'PATCH',
    body: JSON.stringify({ scriptText: '旧版本覆盖', revision: segment.revision }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');

  const confirmed = await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.project.status, 'script_confirmed');
  assert.equal(confirmed.body.version.immutable, true);

  const immutableSegment = confirmed.body.segments[0];
  const immutableUpdate = await request(`/segments/${immutableSegment.id}/draft`, {
    method: 'PATCH',
    body: JSON.stringify({ scriptText: '不可修改', revision: immutableSegment.revision }),
  });
  assert.equal(immutableUpdate.response.status, 409);
  assert.equal(immutableUpdate.body.error.code, 'SCRIPT_VERSION_IMMUTABLE');
});

test('edits visual entity attributes and rebuilds the keyframe prompt from the new bible', async () => {
  const { project } = await createReadyScript();
  await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  const storyboard = await request(`/projects/${project.id}/storyboard-tasks`, { method: 'POST' });
  const storyboardTask = await waitForStoryboardTask(storyboardRunner, storyboard.body.task.id);
  assert.equal(storyboardTask.status, 'succeeded');

  let state = (await request(`/projects/${project.id}`)).body;
  const character = state.visualBible.content.characters[0];
  const shot = state.segments[0].shots[0];
  const patched = await request(`/visual-bibles/${state.visualBible.id}/entities/${character.entityId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      entityKind: 'character',
      revision: state.visualBible.revision,
      age: '28 岁',
      hair: '短黑发',
      costume: '黑色单排扣西装；具体款式未交代',
    }),
  });
  assert.equal(patched.response.status, 200);
  const updatedEntity = patched.body.visualBible.content.characters.find(item => item.entityId === character.entityId);
  assert.equal(updatedEntity.age, '28 岁');
  assert.equal(updatedEntity.locked, true);
  assert.equal(patched.body.appearanceChanged, true);
  assert.equal(updatedEntity.selectedReferenceAssetId, null);

  const started = await request(`/shots/${shot.id}/keyframe-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `keyframe-attributes-${shot.id}` },
    body: JSON.stringify({ count: 1, seed: 11 }),
  });
  assert.equal(started.response.status, 202);
  const task = await waitForGenerationTask(mediaRunner, started.body.task.id);
  assert.equal(task.status, 'succeeded');

  state = (await request(`/projects/${project.id}`)).body;
  const refreshed = state.segments.flatMap(segment => segment.shots || []).find(item => item.id === shot.id);
  assert.match(refreshed.keyframePromptZh, /黑色单排扣西装/);
  assert.match(refreshed.keyframePromptZh, /28 岁/);
  assert.doesNotMatch(refreshed.keyframePromptZh, /未交代/);
});

test('acceptance mode plans and renders a single short shot', async () => {
  const { project } = await createReadyScript();
  await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  const storyboard = await request(`/projects/${project.id}/storyboard-tasks`, {
    method: 'POST',
    body: JSON.stringify({
      visualStyle: 'cinematic', voiceId: 'magnetic', ratio: '9:16',
      acceptanceMode: true, acceptanceShotLimit: 1, acceptanceShotDurationMs: 4000,
    }),
  });
  assert.equal(storyboard.response.status, 202);
  const storyboardTask = await waitForStoryboardTask(storyboardRunner, storyboard.body.task.id);
  assert.equal(storyboardTask.status, 'succeeded');

  let state = (await request(`/projects/${project.id}`)).body;
  assert.equal(state.storyboardPlan.configuration.acceptanceMode, true);
  let shots = state.segments.flatMap(segment => segment.shots || []);
  assert.equal(shots.length, 1, `acceptance mode must plan exactly one shot, got ${shots.length}`);
  assert.equal(shots[0].durationMs, 4000);

  await request(`/storyboard-plans/${state.storyboardPlan.id}/confirm`, { method: 'POST' });
  for (const shot of shots) {
    const started = await request(`/shots/${shot.id}/keyframe-tasks`, {
      method: 'POST', headers: { 'idempotency-key': `acc-keyframe-${shot.id}` },
      body: JSON.stringify({ count: 1, seed: 7 }),
    });
    assert.equal(started.response.status, 202);
    const keyframeTask = await waitForGenerationTask(mediaRunner, started.body.task.id);
    assert.equal(keyframeTask.status, 'succeeded');
  }
  state = (await request(`/projects/${project.id}`)).body;
  shots = state.segments.flatMap(segment => segment.shots || []);
  for (const shot of shots) {
    const selected = await request(`/media-assets/${shot.keyframeCandidates[0].id}/select`, { method: 'POST', body: '{}' });
    assert.equal(selected.response.status, 200);
  }

  const started = await request(`/projects/${project.id}/generation-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `acc-video-${project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic', keyframeRequired: true }),
  });
  assert.equal(started.response.status, 202);
  const generationTask = await waitForGenerationTask(mediaRunner, started.body.task.id);
  assert.equal(generationTask.status, 'succeeded');

  state = (await request(`/projects/${project.id}`)).body;
  assert.ok(Number(state.segments[0].durationMs) <= 4000, `segment duration should follow the acceptance timeline, got ${state.segments[0].durationMs}`);
});

test('locks references, generates and confirms keyframes, then gates I2V generation', async () => {
  const { project } = await createReadyScript();
  await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  const storyboard = await request(`/projects/${project.id}/storyboard-tasks`, { method: 'POST' });
  const storyboardTask = await waitForStoryboardTask(storyboardRunner, storyboard.body.task.id);
  assert.equal(storyboardTask.status, 'succeeded');

  let state = (await request(`/projects/${project.id}`)).body;
  const character = state.visualBible.content.characters[0];
  assert.ok(character?.entityId);
  const referenceTaskResponse = await request(`/projects/${project.id}/reference-assets`, {
    method: 'POST', headers: { 'idempotency-key': `reference-${project.id}` },
    body: JSON.stringify({ entityKind: 'character', entityId: character.entityId, count: 2, seed: 101 }),
  });
  assert.equal(referenceTaskResponse.response.status, 202);
  const referenceTask = await waitForGenerationTask(mediaRunner, referenceTaskResponse.body.task.id);
  assert.equal(referenceTask.status, 'succeeded');
  state = (await request(`/projects/${project.id}`)).body;
  assert.equal(state.referenceAssets.length, 2);
  const selectedReference = state.referenceAssets.find(asset => asset.metadata?.variantId === 'three-view');
  const referenceSelection = await request(`/media-assets/${selectedReference.id}/select`, { method: 'POST', body: '{}' });
  assert.equal(referenceSelection.response.status, 200);
  assert.equal(referenceSelection.body.visualBible.content.characters[0].selectedReferenceAssetId, selectedReference.id);

  const confirmPlan = await request(`/storyboard-plans/${state.storyboardPlan.id}/confirm`, { method: 'POST' });
  assert.equal(confirmPlan.response.status, 200);
  state = (await request(`/projects/${project.id}`)).body;
  const shots = state.segments.flatMap(segment => segment.shots || []);
  assert.ok(shots.length >= 1);

  const blocked = await request(`/projects/${project.id}/generation-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `gated-${project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic', keyframeRequired: true }),
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, 'KEYFRAMES_NOT_CONFIRMED');

  for (const shot of shots) {
    const started = await request(`/shots/${shot.id}/keyframe-tasks`, {
      method: 'POST', headers: { 'idempotency-key': `keyframe-${shot.id}` },
      body: JSON.stringify({ count: 2, seed: 200 + shot.sequence }),
    });
    assert.equal(started.response.status, 202);
    const task = await waitForGenerationTask(mediaRunner, started.body.task.id);
    assert.equal(task.status, 'succeeded', task.error_message || task.error_code || 'keyframe task failed');
  }

  state = (await request(`/projects/${project.id}`)).body;
  for (const shot of state.segments.flatMap(segment => segment.shots || [])) {
    assert.ok(shot.keyframeCandidates.length >= 2);
    const selected = shot.keyframeCandidates[0];
    const selectedResponse = await request(`/media-assets/${selected.id}/select`, { method: 'POST', body: '{}' });
    assert.equal(selectedResponse.response.status, 200);
  }
  state = (await request(`/projects/${project.id}`)).body;
  assert.equal(state.keyframeSummary.confirmed, state.keyframeSummary.total);
  assert.ok(state.segments.flatMap(segment => segment.shots || []).every(shot => shot.generationSignature === null));

  const started = await request(`/projects/${project.id}/generation-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `i2v-${project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic', keyframeRequired: true }),
  });
  assert.equal(started.response.status, 202);
  const task = await waitForGenerationTask(mediaRunner, started.body.task.id);
  const generated = (await request(`/generation-tasks/${task.id}`)).body;
  assert.equal(task.status, 'succeeded', JSON.stringify({ task, children: generated.generationChildren }, null, 2));
  const videoAssets = generated.segments.flatMap(segment => (segment.shots || []).flatMap(shot => shot.media || [])).filter(asset => asset.type === 'shot_video');
  assert.equal(videoAssets.length, state.keyframeSummary.total);
  assert.ok(videoAssets.every(asset => asset.status === 'ready'));
});
test('generates media tasks, assets, and supports idempotent segment regeneration', async () => {
  const { project } = await createReadyScript();
  const confirmed = await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  assert.equal(confirmed.response.status, 200);
  const segment = confirmed.body.segments[0];

  const storyboard = await request(`/projects/${project.id}/storyboard-tasks`, { method: 'POST' });
  assert.equal(storyboard.response.status, 202);
  const storyboardTask = await waitForStoryboardTask(storyboardRunner, storyboard.body.task.id);
  assert.equal(storyboardTask.status, 'succeeded');
  const planned = await request(`/projects/${project.id}`);
  assert.ok(planned.body.segments[0].shots.length >= 1);
  assert.ok(planned.body.storyboardPlan.directorAnalysis.segments.length >= 1);
  assert.ok(planned.body.storyboardPlan.shotSelection.segments.length >= 1);
  const firstShot = planned.body.segments[0].shots[0];
  assert.ok(firstShot.plot && firstShot.shotSize && firstShot.movement && firstShot.angle && firstShot.purpose);
  assert.equal(firstShot.generationSpec.version, 'generation-spec-v6');
  assert.ok(firstShot.generationSpec.visibleAction);
  assert.ok(firstShot.generationSpec.motionPrompt);
  assert.ok(firstShot.focalLengthMm >= 12);
  assert.ok(firstShot.evidenceIds.length >= 1);
  const retrievals = await request(`/storyboard-plans/${planned.body.storyboardPlan.id}/retrievals`);
  assert.ok(retrievals.body.retrievals.length >= 1);

  const blocked = await request(`/projects/${project.id}/generation-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `blocked-${project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic' }),
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, 'STORYBOARD_NOT_CONFIRMED');
  const storyboardConfirm = await request(`/storyboard-plans/${planned.body.storyboardPlan.id}/confirm`, { method: 'POST' });
  assert.equal(storyboardConfirm.response.status, 200);
  const immutableShotEdit = await request(`/shots/${firstShot.id}`, {
    method: 'PATCH', body: JSON.stringify({ plot: '不应该覆盖已确认版本' }),
  });
  assert.equal(immutableShotEdit.response.status, 409);
  assert.equal(immutableShotEdit.body.error.code, 'STORYBOARD_IMMUTABLE');

  const first = await request(`/projects/${project.id}/generation-tasks`, {
    method: 'POST',
    headers: { 'idempotency-key': `video-${project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic' }),
  });
  assert.equal(first.response.status, 202);
  const second = await request(`/projects/${project.id}/generation-tasks`, {
    method: 'POST',
    headers: { 'idempotency-key': `video-${project.id}` },
    body: JSON.stringify({ visualStyle: 'cinematic', voiceId: 'magnetic' }),
  });
  assert.ok(second.body.task, JSON.stringify(second.body));
  assert.equal(second.body.task.id, first.body.task.id);

  const task = await waitForGenerationTask(mediaRunner, first.body.task.id);
  assert.equal(task.status, 'succeeded');
  const generated = await request(`/generation-tasks/${task.id}`);
  assert.equal(generated.body.project.status, 'ready');
  assert.equal(generated.body.segments[0].mediaStatus, 'ready');
  assert.equal(generated.body.segments[0].media.length, 2);
  assert.ok(generated.body.segments[0].shots.length >= 1);
  assert.ok(generated.body.segments[0].shots.every(shot => shot.promptZh && shot.status === 'ready'));
  const oldVersionId = generated.body.segments[0].activeVersionId;

  const regenerate = await request(`/segments/${segment.id}/regenerate`, {
    method: 'POST',
    headers: { 'idempotency-key': `segment-${segment.id}` },
    body: JSON.stringify({
      scriptText: `${segment.scriptText} 新的悬念`, promptText: '雨夜地铁站，冷蓝色电影光影',
      voiceId: 'steady', visualStyle: 'anime',
      shots: generated.body.segments[0].shots.map((shot, index) => ({ ...shot, promptZh: index === 0 ? '用户修改后的镜头提示词' : shot.promptZh })),
    }),
  });
  assert.equal(regenerate.response.status, 202);
  const regeneratedTask = await waitForGenerationTask(mediaRunner, regenerate.body.task.id);
  assert.equal(regeneratedTask.status, 'succeeded');
  const afterRegenerate = await request(`/projects/${project.id}`);
  assert.notEqual(afterRegenerate.body.segments[0].activeVersionId, oldVersionId);
  assert.equal(afterRegenerate.body.segments[0].voiceId, 'steady');
  assert.equal(afterRegenerate.body.segments[0].visualStyle, 'anime');
  assert.equal(afterRegenerate.body.segments[0].mediaStatus, 'ready');
  assert.equal(afterRegenerate.body.segments[0].shots[0].promptZh, '用户修改后的镜头提示词');


});

test('reference candidates get a fresh seed per candidate when no seed is pinned', async () => {
  const { project } = await createReadyScript();
  await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  const storyboard = await request(`/projects/${project.id}/storyboard-tasks`, { method: 'POST' });
  assert.equal(storyboard.response.status, 202);
  const storyboardTask = await waitForStoryboardTask(storyboardRunner, storyboard.body.task.id);
  assert.equal(storyboardTask.status, 'succeeded');

  let state = (await request(`/projects/${project.id}`)).body;
  const character = state.visualBible.content.characters[0];
  assert.ok(character?.entityId);

  // 不传 seed：每个候选都应由 provider 随机取种（旧 bug 会固定成 0/1/2/3，重新生成几乎不变）
  const randomBatch = await request(`/projects/${project.id}/reference-assets`, {
    method: 'POST', headers: { 'idempotency-key': `reference-random-${project.id}` },
    body: JSON.stringify({ entityKind: 'character', entityId: character.entityId, count: 4 }),
  });
  assert.equal(randomBatch.response.status, 202);
  const randomTask = await waitForGenerationTask(mediaRunner, randomBatch.body.task.id);
  assert.equal(randomTask.status, 'succeeded');
  const randomSeeds = JSON.parse(randomTask.configuration_json).seedList;
  assert.equal(randomSeeds.length, 4);
  assert.equal(new Set(randomSeeds.map(String)).size, 4, `未指定 seed 时每个候选都要有自己的种子，实际 ${JSON.stringify(randomSeeds)}`);

  state = (await request(`/projects/${project.id}`)).body;
  const candidates = state.referenceAssets.filter(asset => asset.metadata?.entityId === character.entityId);
  assert.equal(candidates.length, 4);
  assert.equal(new Set(candidates.map(asset => asset.objectKey)).size, 4, '每个候选必须落到独立文件，不能互相覆盖');

  // 显式传 seed：仍按候选递增，方便复现某一版
  const pinnedBatch = await request(`/projects/${project.id}/reference-assets`, {
    method: 'POST', headers: { 'idempotency-key': `reference-pinned-${project.id}` },
    body: JSON.stringify({ entityKind: 'character', entityId: character.entityId, count: 2, seed: 500 }),
  });
  assert.equal(pinnedBatch.response.status, 202);
  const pinnedTask = await waitForGenerationTask(mediaRunner, pinnedBatch.body.task.id);
  assert.equal(pinnedTask.status, 'succeeded');
  assert.deepEqual(JSON.parse(pinnedTask.configuration_json).seedList, [500, 501]);
});

test('keyframe task hands both the character and the scene reference to the image provider', async () => {
  const { project } = await createReadyScript();
  await request(`/projects/${project.id}/script/confirm`, { method: 'POST' });
  const storyboard = await request(`/projects/${project.id}/storyboard-tasks`, { method: 'POST' });
  assert.equal(storyboard.response.status, 202);
  const storyboardTask = await waitForStoryboardTask(storyboardRunner, storyboard.body.task.id);
  assert.equal(storyboardTask.status, 'succeeded');

  let state = (await request(`/projects/${project.id}`)).body;
  const character = state.visualBible.content.characters[0];
  const scene = state.visualBible.content.scenes[0];
  assert.ok(character?.entityId && scene?.entityId);

  for (const entity of [{ kind: 'character', id: character.entityId, count: 1 }, { kind: 'scene', id: scene.entityId, count: 5 }]) {
    const batch = await request(`/projects/${project.id}/reference-assets`, {
      method: 'POST', headers: { 'idempotency-key': `reference-${entity.kind}-${project.id}` },
      body: JSON.stringify({ entityKind: entity.kind, entityId: entity.id, count: entity.count }),
    });
    assert.equal(batch.response.status, 202);
    const task = await waitForGenerationTask(mediaRunner, batch.body.task.id);
    assert.equal(task.status, 'succeeded');
  }

  state = (await request(`/projects/${project.id}`)).body;
  const characterAsset = state.referenceAssets.find(asset => asset.metadata?.entityKind === 'character');
  const sceneAsset = state.referenceAssets.find(asset => asset.metadata?.entityKind === 'scene');
  assert.ok(characterAsset && sceneAsset);
  await request(`/media-assets/${characterAsset.id}/select`, { method: 'POST', body: '{}' });
  await request(`/media-assets/${sceneAsset.id}/select`, { method: 'POST', body: '{}' });
  await request(`/storyboard-plans/${state.storyboardPlan.id}/confirm`, { method: 'POST' });

  state = (await request(`/projects/${project.id}`)).body;
  const shot = state.segments.flatMap(segment => segment.shots || [])[0];
  assert.ok(shot?.id);

  mediaProvider.imageCalls.length = 0;
  const started = await request(`/shots/${shot.id}/keyframe-tasks`, {
    method: 'POST', headers: { 'idempotency-key': `keyframe-multi-${shot.id}` },
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(started.response.status, 202);
  const task = await waitForGenerationTask(mediaRunner, started.body.task.id);
  assert.equal(task.status, 'succeeded', task.error_message || task.error_code || 'keyframe task failed');
  assert.equal(mediaProvider.imageCalls.length, 1);

  const call = mediaProvider.imageCalls[0];
  assert.ok(call.referenceImagePath, '必须提供主参考图');
  assert.match(call.referenceImagePath, /reference_scene_/, '画布必须是场景图：它会经 VAEEncode 接进采样器的 latent_image');
  assert.equal(call.referenceImagePaths.length, 2, '角色三视图 + 另一机位场景图要一起传给 provider');
  assert.notEqual(call.referenceImagePath, call.referenceImagePaths[0]);
  assert.match(call.prompt, /Reference Image 1: Environment canvas/);
  assert.match(call.prompt, /Reference Image 2: Character design reference/);
  assert.match(call.prompt, /Reference Image 3: Additional environment view/);
  assert.match(call.prompt, /Do not reproduce its multiple-view layout/);
  assert.match(call.prompt, /Add the character from the character reference into the environment canvas/);
  assert.match(call.prompt, /把角色参考图中的角色放进场景参考图/);
  assert.match(call.prompt, /\n镜头：/);
  assert.match(call.prompt, /\n角色：/);
  assert.doesNotMatch(call.prompt, /【角色】|【场景】/, '有锁定参考图时不复述整套设定');
  assert.doesNotMatch(call.prompt, /年龄|发型发色|固定服装/);
});
