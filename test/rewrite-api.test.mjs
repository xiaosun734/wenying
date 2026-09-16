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
    return { characters: [], scenes: segments.map((item, index) => ({ name: item.title || `Scene ${index + 1}`, description: item.summary || item.scriptText.slice(0, 60) })), style: `${genre}, ${visualStyle}, consistent character and wardrobe` };
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

class FixtureMediaProvider {
  constructor() { this.provider = 'fixture'; this.model = 'fixture-media-v1'; }
  async generateVideo({ segmentVersion, shot = null }) {
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
  mediaRoot = await mkdtemp(join(tmpdir(), 'wenying-fixture-media-'));
  const mediaProvider = new FixtureMediaProvider();
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
  assert.equal(task.status, 'succeeded');
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
  assert.equal(firstShot.generationSpec.version, 'generation-spec-v1');
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
