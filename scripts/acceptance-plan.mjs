#!/usr/bin/env node
/**
 * 把某个已确认的项目重新策划成“快速验收版”：只保留 1 个镜头、约 5 秒。
 * 复用已有的导演分析，不重跑文案改写，也不动原来的策划版本（会新建一个策划版本）。
 *
 * 用法（需要先 pnpm dev 启动服务）：
 *   node scripts/acceptance-plan.mjs --project=夜行者2
 *   node scripts/acceptance-plan.mjs --project=<projectId> --limit=1 --duration=5000
 */
const args = new Map(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=') || 'true'];
}));

const port = args.get('port') || process.env.PORT || '4173';
const base = `http://127.0.0.1:${port}/api/v1`;
const hint = args.get('project') || '';
const shotLimit = Math.max(1, Math.min(6, Number(args.get('limit')) || 1));
const shotDurationMs = Math.max(1000, Math.min(6000, Number(args.get('duration')) || 5000));

const projects = await get('/projects');
const project = pick(projects.projects || []);
if (!project) exit(`找不到项目${hint ? `：${hint}` : ''}`);
if (!project.activeScriptVersionId && !project.draftScriptVersionId) exit(`项目「${project.title}」还没有确认文案`);

const state = await get(`/projects/${project.id}`);
const plan = state.storyboardPlan;
if (!plan) exit(`项目「${project.title}」还没有前期策划，请先在页面上跑一次策划`);

console.log(`项目     ${project.title} (${project.id})`);
console.log(`基准策划 ${plan.id} (${plan.status})`);
console.log(`验收参数 每个片段 ${shotLimit} 个镜头 / 单镜 ${shotDurationMs}ms`);
console.log('');

const started = await post(`/storyboard-plans/${plan.id}/regenerate`, {
  fromLayer: 'camera', acceptanceMode: true,
  acceptanceShotLimit: shotLimit, acceptanceShotDurationMs: shotDurationMs,
}, `acceptance-${project.id}-${Date.now()}`);
const taskId = started.task?.id;
if (!taskId) exit('创建策划任务失败');

let task = null;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await sleep(1500);
  const payload = await get(`/storyboard-tasks/${taskId}`);
  task = payload.task;
  process.stdout.write(`\r策划中：${task.step} ${task.progress}%   `);
  if (['succeeded', 'failed', 'canceled'].includes(task.status)) break;
}
process.stdout.write('\n');

if (!task || task.status !== 'succeeded') exit(`策划失败：${task?.errorMessage || task?.errorCode || '未知错误'}`);

const finalState = await get(`/projects/${project.id}`);
const shots = finalState.segments.flatMap(segment => segment.shots || []);
console.log(`策划完成：${shots.length} 个镜头，时长 ${shots.map(shot => `${(shot.durationMs / 1000).toFixed(1)}s`).join('、')}`);
console.log('');
console.log('接下来在页面上完成：');
console.log('  1. 前期策划审核 → 视觉资产：确认角色/场景参考图已锁定');
console.log(`  2. 关键帧审核：对 ${shots.length} 个镜头点“生成关键帧”→ 选一张`);
console.log('  3. 点“开始图生视频”等成片');
console.log(`  4. 跑 pnpm verify 检查`);

async function get(path) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) exit(`${path} 请求失败：HTTP ${response.status}`);
  return response.json();
}

async function post(path, body, idempotencyKey) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) exit(`${path} 请求失败：HTTP ${response.status} ${payload?.error?.message || ''}`);
  return payload;
}

function pick(list) {
  if (hint) return list.find(item => item.id === hint) || list.filter(item => item.title === hint).sort(byUpdated)[0];
  return list.slice().sort(byUpdated)[0];
}

function byUpdated(a, b) {
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function exit(message) {
  console.error(`验收模式切换失败：${message}`);
  process.exit(1);
}
