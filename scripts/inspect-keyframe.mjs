#!/usr/bin/env node
/**
 * 查看某次关键帧到底提交了什么：
 *   1) data/wenying.sqlite → media_assets.metadata_json（提示词 / 负向词 / 参考图 / manifest）
 *   2) data/generation-metadata.jsonl（每次生成追加的一条审计记录）
 *   3) ComfyUI /history/<prompt_id>（真正跑的那个工作流）
 *
 * 用法：
 *   node scripts/inspect-keyframe.mjs                  只看最近 1 条
 *   node scripts/inspect-keyframe.mjs --limit 3        看最近 3 条
 *   node scripts/inspect-keyframe.mjs --shot 390aa6b7  只看某个镜头（id 前缀）
 *   node scripts/inspect-keyframe.mjs --json           额外打印原始 metadata_json
 *   node scripts/inspect-keyframe.mjs --no-history     不查 ComfyUI 历史
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const value = name => {
  const index = args.indexOf('--' + name);
  return index >= 0 ? args[index + 1] : null;
};

const limit = Math.max(1, Number(value('limit') || 1));
const shotFilter = value('shot');
const showJson = flag('json');
const withHistory = !flag('no-history');

const env = await readDotEnv(resolve(root, '.env'));
const dbPath = resolve(root, env.DATABASE_PATH || 'data/wenying.sqlite');
const logPath = resolve(root, 'data', 'generation-metadata.jsonl');
const baseUrl = String(env.COMFYUI_BASE_URL || '').replace(/\/+$/, '');
const mediaRoot = resolve(root, env.MEDIA_OUTPUT_DIR || 'data/media');

const db = new DatabaseSync(dbPath, { readOnly: true });
let sql = "SELECT id, shot_id, type, object_key, created_at, metadata_json FROM media_assets WHERE type LIKE '%keyframe%'";
const params = [];
if (shotFilter) { sql += ' AND shot_id LIKE ?'; params.push(shotFilter + '%'); }
sql += ' ORDER BY created_at DESC LIMIT ?';
params.push(limit);
const rows = db.prepare(sql).all(...params);

if (!rows.length) {
  console.log('没有找到关键帧资产。');
  process.exit(0);
}

const logLines = await readJsonl(logPath);
console.log('数据库：' + dbPath);
console.log('审计日志：' + logPath + '（' + logLines.length + ' 条）');
console.log('');

for (const [index, row] of rows.entries()) {
  const meta = safeJson(row.metadata_json) || {};
  console.log('='.repeat(78));
  console.log(`[${index + 1}] ${row.created_at}  ${row.type}`);
  console.log('文件    ：' + String(row.object_key || '').split('/').pop());
  console.log('本地路径：' + resolve(mediaRoot, row.object_key || ''));
  console.log('seed    ：' + meta.seed + '    workflowHash：' + String(meta.workflowHash || '').slice(0, 12));
  console.log('工作流  ：' + String(meta.workflowPath || '').split(/[\\/]/).pop() + '   manifest：' + (meta.manifestProfileId || '-'));
  console.log('主参考  ：' + baseName(meta.referenceImagePath));
  const companions = Array.isArray(meta.companionReferenceImagePaths) ? meta.companionReferenceImagePaths : [];
  console.log('补充参考：' + (companions.length ? companions.map(baseName).join('  +  ') : '(无)'));
  console.log('startImage：' + meta.startImage + '   referenceImagesUsed：' + meta.referenceImagesUsed + '   promptId：' + (meta.promptId || '-'));
  console.log('');
  console.log('--- 正向提示词（实际提交）---');
  console.log(String(meta.prompt || '').trim() || '(空)');
  console.log('');
  console.log('--- 负向提示词（实际提交）---');
  console.log(String(meta.negativePrompt || '').trim() || '(空)');
  console.log('');

  const record = logLines.find(line => line?.asset?.id === row.id);
  console.log('审计记录：' + (record ? '命中第 ' + record.__line + ' 行（shot.promptZh / generationSpec 也在里面）' : '未找到对应行'));
  if (showJson) {
    console.log('');
    console.log('--- 原始 metadata_json ---');
    console.log(JSON.stringify(meta, null, 2));
  }

  if (withHistory && baseUrl && meta.promptId) {
    const entry = await fetchHistory(baseUrl, meta.promptId, env);
    console.log('');
    if (!entry) {
      console.log('ComfyUI 历史：未找到 promptId ' + meta.promptId + '（可能是服务重启后历史被清空）');
    } else {
      console.log('--- ComfyUI /history/' + meta.promptId + ' 实际执行的节点 ---');
      for (const [nodeId, node] of Object.entries(entry.prompt?.[2] || entry.prompt || {})) {
        if (!node?.class_type) continue;
        const brief = describeNode(node);
        if (!brief) continue;
        console.log(`  节点 ${nodeId} ${node.class_type}: ${brief}`);
      }
      const outputs = Object.values(entry.outputs || {}).flatMap(o => o.images || []).map(i => i.filename);
      if (outputs.length) console.log('  输出文件: ' + outputs.join(', '));
      const submittedPositive = findPositiveText(entry);
      if (submittedPositive) {
        console.log('  正向提示词与数据库' + (submittedPositive === String(meta.prompt || '').trim() ? '一致 ✓' : '不一致 ✗（以 ComfyUI 这份为准）'));
        if (submittedPositive !== String(meta.prompt || '').trim()) console.log('  ComfyUI 侧: ' + submittedPositive.slice(0, 200) + '...');
      }
    }
  }
  console.log('');
}

function describeNode(node) {
  const inputs = node.inputs || {};
  const parts = [];
  for (const key of ['text', 'prompt', 'image', 'seed', 'steps', 'cfg', 'denoise', 'shift', 'width', 'height', 'unet_name', 'clip_name', 'vae_name', 'lora_name', 'filename_prefix']) {
    const value = inputs[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) { parts.push(key + '=←' + value.join(':')); continue; }
    if (typeof value === 'string' && value.length > 80) parts.push(key + '="' + value.slice(0, 80) + '…"');
    else parts.push(key + '=' + JSON.stringify(value));
  }
  return parts.join('  ');
}

function findPositiveText(entry) {
  const nodes = entry.prompt?.[2] || entry.prompt || {};
  for (const node of Object.values(nodes)) {
    const type = String(node?.class_type || '');
    if (!/TextEncodeQwenImageEditPlus|CLIPTextEncode/.test(type)) continue;
    const stored = typeof node.inputs?.prompt === 'string' ? node.inputs.prompt : node.inputs?.text;
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
  }
  return null;
}

async function fetchHistory(baseUrl, promptId, env) {
  const headers = {};
  if (env.COMFYUI_API_KEY) headers['X-API-Key'] = env.COMFYUI_API_KEY;
  if (env.COMFYUI_AUTH_TOKEN) headers.Authorization = 'Bearer ' + env.COMFYUI_AUTH_TOKEN;
  if (env.COMFYUI_BASIC_AUTH) headers.Authorization = 'Basic ' + Buffer.from(env.COMFYUI_BASIC_AUTH).toString('base64');
  try {
    const response = await fetch(baseUrl + '/history/' + encodeURIComponent(promptId), { headers });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.[promptId] || null;
  } catch (error) {
    console.log('ComfyUI 历史查询失败：' + error.message);
    return null;
  }
}

async function readJsonl(path) {
  try {
    await stat(path);
  } catch {
    return [];
  }
  const contents = await readFile(path, 'utf8');
  const out = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const parsed = safeJson(line);
    if (parsed) { parsed.__line = index + 1; out.push(parsed); }
  });
  return out;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function baseName(path) {
  return path ? String(path).split(/[\\/]/).pop() : '(无)';
}

async function readDotEnv(path) {
  const result = {};
  let contents = '';
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return result;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return result;
}
