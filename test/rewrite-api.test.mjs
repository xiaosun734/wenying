import assert from 'node:assert/strict';
import http from 'node:http';
import test, { afterEach, beforeEach } from 'node:test';
import { openDatabase, closeDatabase } from '../server/db.mjs';
import { createApi } from '../server/api.mjs';
import { RewriteTaskRunner, waitForTask } from '../server/rewrite-task.mjs';
import { MockTextProvider } from '../server/providers/openai-compatible.mjs';
import { MockMediaProvider } from '../server/providers/media.mjs';
import { MediaTaskRunner, waitForGenerationTask } from '../server/media-task.mjs';
import { ExportTaskRunner, waitForExportTask } from '../server/export-task.mjs';
import { KnowledgeRetriever, seedKnowledgeDirectory } from '../server/knowledge-retriever.mjs';
import { StoryboardTaskRunner, waitForStoryboardTask } from '../server/storyboard-task.mjs';
import { resolve } from 'node:path';

let db;
let runner;
let mediaRunner;
let exportRunner;
let storyboardRunner;
let textProvider;
let server;
let baseUrl;

const source = length => {
  const paragraph = '沈砚在地铁站醒来。';
  return paragraph.repeat(Math.ceil(length / Array.from(paragraph).length)).slice(0, length);
};

beforeEach(async () => {
  db = await openDatabase(':memory:');
  await seedKnowledgeDirectory(db, resolve('knowledge'));
  textProvider = new MockTextProvider();
  runner = new RewriteTaskRunner({ db, provider: textProvider, logger: { error() {} } });
  const mediaProvider = new MockMediaProvider({ stepDelayMs: 0 });
  mediaRunner = new MediaTaskRunner({ db, provider: mediaProvider, textProvider, logger: { error() {} } });
  exportRunner = new ExportTaskRunner({ db, logger: { error() {} }, stepDelayMs: 0 });
  storyboardRunner = new StoryboardTaskRunner({ db, provider: textProvider, retriever: new KnowledgeRetriever({ db }), logger: { error() {} } });
  const api = createApi({ db, runner, provider: textProvider, mediaRunner, mediaProvider, exportRunner, storyboardRunner });
  server = http.createServer((req, res) => api(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDatabase(db);
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
  assert.equal(generated.body.segments[0].media.length, 3);
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

  const exportStart = await request(`/projects/${project.id}/export-tasks`, {
    method: 'POST',
    headers: { 'idempotency-key': `export-${project.id}` },
    body: JSON.stringify({ ratio: '9:16', resolution: '1080p' }),
  });
  assert.equal(exportStart.response.status, 202);
  const exportTask = await waitForExportTask(exportRunner, exportStart.body.task.id);
  assert.equal(exportTask.status, 'succeeded');
  const exports = await request(`/projects/${project.id}/exports`);
  assert.equal(exports.body.exports[0].status, 'succeeded');
  assert.equal(exports.body.exports[0].ratio, '9:16');
});
