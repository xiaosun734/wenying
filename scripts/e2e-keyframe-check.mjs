#!/usr/bin/env node
/**
 * 端到端跑一次关键帧任务：向本地服务发请求 → 等任务完成 → 打印新候选的文件和元数据。
 * 用法：node scripts/e2e-keyframe-check.mjs <shotId> [count]
 */
const apiUrl = (process.env.WENYING_API_URL || 'http://127.0.0.1:4173/api/v1').replace(/\/+$/, '');
const arg = process.argv[2] || '';
if (!arg) {
  console.error('用法：node scripts/e2e-keyframe-check.mjs <shotId> [count]');
  console.error('      node scripts/e2e-keyframe-check.mjs watch:<taskId> <shotId>');
  process.exit(1);
}

let shotId = arg;
let count = Number(process.argv[3] || 1);
let taskId = null;
if (arg.startsWith('watch:')) {
  taskId = arg.slice('watch:'.length);
  shotId = process.argv[3];
  count = Number(process.argv[4] || 1);
  console.log('继续跟踪任务', taskId, 'shot', shotId);
} else {
  const started = await fetch(`${apiUrl}/shots/${shotId}/keyframe-tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `e2e-keyframe-${shotId}-${Date.now()}` },
    body: JSON.stringify({ count }),
  });
  const startedBody = await started.json().catch(() => ({}));
  if (started.status !== 202) {
    console.error('提交失败', started.status, JSON.stringify(startedBody).slice(0, 1500));
    process.exit(1);
  }
  taskId = startedBody?.task?.id;
  console.log('任务已提交', taskId, 'shot', shotId);
}

const deadline = Date.now() + 30 * 60 * 1000;
let task = null;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 5000));
  const response = await fetch(`${apiUrl}/generation-tasks/${taskId}`);
  if (!response.ok) continue;
  const body = await response.json();
  task = body?.task || body;
  process.stdout.write(`\r状态：${task?.status}  进度：${task?.progress ?? '-'}%   `);
  if (task?.status && task.status !== 'queued' && task.status !== 'running') break;
}
console.log('');
console.log('最终状态：', task?.status, task?.error_code || '', task?.error_message || '');

const { DatabaseSync } = await import('node:sqlite');
const { resolve } = await import('node:path');
const db = new DatabaseSync(resolve(import.meta.dirname, '..', 'data', 'wenying.sqlite'), { readOnly: true });
const rows = db.prepare(
  "SELECT id, object_key, created_at, metadata_json FROM media_assets WHERE shot_id = ? AND type LIKE '%keyframe%' ORDER BY created_at DESC LIMIT ?",
).all(shotId, count);
for (const row of rows) {
  const meta = JSON.parse(row.metadata_json || '{}');
  console.log('候选：', row.object_key);
  console.log('  主参考(画布)：', meta.referenceImagePath);
  console.log('  补充参考：', JSON.stringify(meta.companionReferenceImagePaths));
  console.log('  startImage/refUsed：', meta.startImage, meta.referenceImagesUsed);
  console.log('  promptId：', meta.promptId);
}
