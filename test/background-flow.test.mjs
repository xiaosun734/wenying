import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { clearExpiredSources, closeDatabase, createProject, getProject, openDatabase } from '../server/db.mjs';
import { OpenAICompatibleProvider } from '../server/providers/openai-compatible.mjs';

test('migrates a legacy projects table and persists the background', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wenying-migration-'));
  const filename = join(root, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      genre TEXT NOT NULL,
      source_text TEXT,
      copyright_confirmed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      draft_script_version_id TEXT,
      active_script_version_id TEXT,
      source_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.prepare(`
    INSERT INTO projects(id, title, genre, source_text, copyright_confirmed, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 'draft', ?, ?)
  `).run('legacy-1', '旧作品', '悬疑', '旧正文', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  legacy.close();

  const db = await openDatabase(filename, { metadataLogPath: '' });
  try {
    const columns = db.prepare('PRAGMA table_info(projects)').all().map(column => column.name);
    assert.ok(columns.includes('background'));
    const migrated = getProject(db, 'legacy-1');
    assert.equal(migrated.title, '旧作品');
    assert.equal(migrated.background, null);
    const created = createProject(db, {
      id: 'new-1', title: '新作品', genre: '悬疑', background: '主角沈砚，28 岁刑警。', sourceText: '正文',
    });
    assert.equal(created.background, '主角沈砚，28 岁刑警。');
  } finally {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('clears the background together with an expired source', async () => {
  const db = await openDatabase(':memory:', { metadataLogPath: '' });
  try {
    createProject(db, {
      id: 'expired-1', title: '过期作品', genre: '悬疑', background: '旧背景',
      sourceText: '旧正文', sourceExpiresAt: '2020-01-01T00:00:00.000Z',
    });
    assert.equal(clearExpiredSources(db), 1);
    const project = getProject(db, 'expired-1');
    assert.equal(project.source_text, null);
    assert.equal(project.background, null);
  } finally {
    closeDatabase(db);
  }
});

test('renders the background placeholder into the real provider request', async () => {
  const promptKeys = [
    'LLM_REWRITE_SYSTEM_PROMPT',
    'LLM_REWRITE_USER_PROMPT_TEMPLATE',
    'LLM_SHOT_USER_PROMPT_TEMPLATE',
    'LLM_VISUAL_BIBLE_USER_PROMPT_TEMPLATE',
    'LLM_DIRECTOR_USER_PROMPT_TEMPLATE',
    'LLM_CAMERA_USER_PROMPT_TEMPLATE',
    'LLM_STORYBOARD_USER_PROMPT_TEMPLATE',
  ];
  const previous = new Map(promptKeys.map(key => [key, process.env[key]]));
  process.env.LLM_REWRITE_SYSTEM_PROMPT = 'rewrite system';
  process.env.LLM_SHOT_SYSTEM_PROMPT = 'shot system';
  process.env.LLM_VISUAL_BIBLE_SYSTEM_PROMPT = 'visual bible system';
  process.env.LLM_DIRECTOR_SYSTEM_PROMPT = 'director system';
  process.env.LLM_CAMERA_SYSTEM_PROMPT = 'camera system';
  process.env.LLM_STORYBOARD_SYSTEM_PROMPT = 'storyboard system';
  process.env.LLM_REWRITE_USER_PROMPT_TEMPLATE = '题材：{genre}\n背景设定：{background}\n正文：{sourceText}';
  process.env.LLM_SHOT_USER_PROMPT_TEMPLATE = '题材：{genre}\n背景设定：{background}\n口播：{scriptText}';
  process.env.LLM_VISUAL_BIBLE_USER_PROMPT_TEMPLATE = '题材：{genre}\n背景设定：{background}\n片段：{segments}';
  process.env.LLM_DIRECTOR_USER_PROMPT_TEMPLATE = '题材：{genre}\n背景设定：{background}\n片段：{segments}';
  process.env.LLM_CAMERA_USER_PROMPT_TEMPLATE = '视觉设定：{visualBible}\n背景设定：{background}\n配置：{configuration}';
  process.env.LLM_STORYBOARD_USER_PROMPT_TEMPLATE = '导演分析：{directorAnalysis}\n背景设定：{background}\n配置：{configuration}';

  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const background = '主角沈砚，28 岁刑警；南方小城常年阴雨。';
    const provider = new OpenAICompatibleProvider({
      provider: 'test', baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'test-key', model: 'test-model', timeoutMs: 2000,
    });
    await provider.rewrite({ sourceText: '正文内容', background, genre: '悬疑', idempotencyKey: 'test-1' });
    await provider.generateVisualBible({ segments: [], background, genre: '悬疑', visualStyle: 'cinematic', idempotencyKey: 'test-2' });
    await provider.generateDirectorAnalysis({ segments: [], background, genre: '悬疑', configuration: {}, idempotencyKey: 'test-3' });
    await provider.generateShotSelection({ directorAnalysis: {}, retrievalContexts: [], visualBible: {}, background, configuration: {}, idempotencyKey: 'test-4' });
    await provider.generateStoryboard({ directorAnalysis: {}, shotSelection: {}, visualBible: {}, background, configuration: {}, idempotencyKey: 'test-5' });

    assert.equal(bodies.length, 5);
    for (const body of bodies) {
      const userMessage = body.messages[1].content;
      assert.doesNotMatch(userMessage, /\{background\}/, 'placeholder should be rendered, not passed through');
      assert.ok(userMessage.includes(background), 'user prompt should carry the background text');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
