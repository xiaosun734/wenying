#!/usr/bin/env node
/**
 * 只读验收脚本：检查“参考资产 → 关键帧 → 图生视频 → 合成”这条链路是否真的成立。
 *
 * 用法：
 *   node scripts/verify-accuracy.mjs
 *   node scripts/verify-accuracy.mjs --project=夜行者
 *   node scripts/verify-accuracy.mjs --project=<projectId> --db=data/wenying.sqlite --media-root=data/media
 *
 * 脚本不会写入数据库，也不会修改任何媒体文件。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const args = new Map(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=') || 'true'];
}));

const dbPath = resolve(args.get('db') || 'data/wenying.sqlite');
const mediaRoot = resolve(args.get('media-root') || 'data/media');
const ffprobePath = args.get('ffprobe') || 'ffprobe';
const projectHint = args.get('project') || '';

if (!existsSync(dbPath)) fail(`数据库不存在：${dbPath}`);
const db = openDatabase(dbPath);

const results = [];
const manualChecks = [];
const check = (name, ok, detail = '', level = 'fail') => {
  results.push({ name, ok, detail, level: ok ? 'pass' : level });
};
const warn = (name, detail) => check(name, false, detail, 'warn');

const project = pickProject(db, projectHint);
if (!project) fail(`找不到项目${projectHint ? `：${projectHint}` : ''}。可用 --project=<作品名或ID> 指定。`);

console.log('文影准确性验收（只读）');
console.log('='.repeat(72));
console.log(`项目      ${project.title}  (${project.id})`);
console.log(`数据库    ${dbPath}`);
console.log(`媒体目录  ${mediaRoot}`);
console.log('');

check('数据库 schema 版本 ≥ 8', Number(schemaVersion(db)) >= 8, `当前 ${schemaVersion(db)}`);

const plan = project.active_storyboard_plan_id
  ? db.prepare('SELECT * FROM storyboard_plans WHERE id = ?').get(project.active_storyboard_plan_id)
  : null;
check('存在已确认的前期策划版本', Boolean(plan && plan.status === 'confirmed'), plan ? `status=${plan.status}` : '缺少 active_storyboard_plan_id');

const bible = db.prepare('SELECT * FROM visual_bibles WHERE project_id = ? ORDER BY revision DESC LIMIT 1').get(project.id);
check('存在已确认的 Visual Bible', Boolean(bible && bible.confirmed), bible ? `revision=${bible.revision}` : '缺少 visual_bibles 记录');

const versions = db.prepare(`
  SELECT sv.* FROM segment_versions sv
  JOIN segments s ON s.id = sv.segment_id
  WHERE s.project_id = ?
`).all(project.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
const version = versions.find(item => item.status === 'ready') || versions[0] || null;
check('存在片段版本', Boolean(version), version ? `version=${version.id}` : '没有 segment_versions');

const shots = version
  ? db.prepare('SELECT * FROM segment_shots WHERE segment_version_id = ? ORDER BY sequence').all(version.id)
  : [];
check('存在镜头', shots.length > 0, `${shots.length} 个镜头`);

const assets = db.prepare('SELECT * FROM media_assets WHERE project_id = ?').all(project.id).map(row => ({
  ...row, metadata: parseJson(row.metadata_json), objectKey: row.object_key,
}));

const confirmedKeyframes = shots.filter(shot => shot.keyframe_status === 'confirmed' && shot.selected_keyframe_asset_id);
check(
  '每个镜头都已确认关键帧',
  shots.length > 0 && confirmedKeyframes.length === shots.length,
  `${confirmedKeyframes.length}/${shots.length} 已确认`,
);

let keyframesUsingReference = 0;
let keyframesMissingReference = 0;
for (const shot of shots) {
  const keyframe = assets.find(asset => asset.id === shot.selected_keyframe_asset_id);
  if (!keyframe) continue;
  if (keyframe.status !== 'ready') warn(`镜头 ${shot.sequence} 关键帧状态`, `status=${keyframe.status}`);
  const meta = keyframe.metadata || {};
  if (meta.startImage === true) keyframesUsingReference += 1;
  else {
    keyframesMissingReference += 1;
    warn(`镜头 ${shot.sequence} 关键帧未使用参考图`, `profile=${meta.manifestProfileId || '未知'}，工作流退化为文生图`);
  }
  if (!keyframe.generation_signature) warn(`镜头 ${shot.sequence} 关键帧缺少 generationSignature`, '');
  if (!meta.visualBibleHash) warn(`镜头 ${shot.sequence} 关键帧缺少 visualBibleHash`, '');
}
check(
  '关键帧实际消费了参考图',
  shots.length > 0 && keyframesMissingReference === 0,
  `${keyframesUsingReference}/${shots.length} 使用参考图（img2img）`,
);

const videosByShot = new Map();
for (const asset of assets.filter(item => item.type === 'shot_video' && item.status === 'ready')) {
  const list = videosByShot.get(asset.shot_id) || [];
  list.push(asset);
  videosByShot.set(asset.shot_id, list);
}
let videosBoundToKeyframe = 0;
let durationDrift = 0;
for (const shot of shots) {
  const list = videosByShot.get(shot.id) || [];
  const video = list[list.length - 1];
  if (!video) { warn(`镜头 ${shot.sequence} 缺少 ready 的 shot_video`, ''); continue; }
  const meta = video.metadata || {};
  if (meta.startImage === true) videosBoundToKeyframe += 1;
  else warn(`镜头 ${shot.sequence} 视频未消费首帧`, `profile=${meta.manifestProfileId || '未知'}`);
  if (shot.selected_keyframe_asset_id && meta.keyframeAssetId !== shot.selected_keyframe_asset_id) {
    warn(`镜头 ${shot.sequence} 视频与当前关键帧不一致`, `video.keyframeAssetId=${meta.keyframeAssetId || '无'}`);
  }
  const requested = Number(meta.requestedDurationMs || shot.duration_ms || 0);
  const actual = Number(meta.actualDurationMs || video.duration_ms || 0);
  if (requested && actual && Math.abs(actual - requested) > 50) durationDrift += 1;
  if (!existsSync(resolve(mediaRoot, video.object_key))) warn(`镜头 ${shot.sequence} 视频文件缺失`, video.object_key);
}
check(
  '每镜视频都消费了已确认关键帧',
  shots.length > 0 && videosByShot.size >= shots.length && videosBoundToKeyframe === shots.length,
  `${videosBoundToKeyframe}/${shots.length} 使用首帧`,
);
check('镜头时长误差 ≤ 50ms', durationDrift === 0, durationDrift ? `${durationDrift} 个镜头超出 50ms` : '全部在容差内', durationDrift ? 'warn' : 'fail');

const audio = assets.filter(item => item.type === 'audio' && item.status === 'ready').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
const shotTotal = shots.reduce((sum, shot) => sum + Number(shot.duration_ms || 0), 0);
const acceptance = plan?.configuration?.acceptanceMode
  ? {
    shotLimit: Math.max(1, Number(plan.configuration.acceptanceShotLimit) || 1),
    shotDurationMs: Math.max(1000, Number(plan.configuration.acceptanceShotDurationMs) || 5000),
  }
  : null;
const readyComposition = assets
  .filter(item => item.type === 'video' && item.status === 'ready')
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
const compositionDurationMs = readyComposition?.duration_ms ?? null;
if (acceptance) {
  check(
    `验收模式：只规划了 ${acceptance.shotLimit} 个镜头`,
    shots.length === acceptance.shotLimit,
    `实际 ${shots.length} 个镜头，单镜上限 ${acceptance.shotDurationMs}ms`,
  );
  check('验收模式：成片时长等于镜头时间轴', Math.abs((compositionDurationMs ?? 0) - shotTotal) <= 100, `成片 ${compositionDurationMs ?? '无'}ms / 镜头合计 ${shotTotal}ms`);
  manualChecks.push('验收模式：成片只覆盖解说文案的开头，字幕与旁白应对应同一段内容。');
} else {
  check(
    '镜头时长之和等于真实 TTS 时长',
    Boolean(audio) && shotTotal === Number(audio.duration_ms),
    `镜头合计 ${shotTotal}ms / 音频 ${audio?.duration_ms ?? '无'} ms`,
  );
}
if (audio) check('TTS 时长来自 ffprobe 实测', audio.metadata?.durationSource === 'ffprobe', `durationSource=${audio.metadata?.durationSource || '未知'}`, 'warn');

const subtitle = assets.filter(item => item.type === 'subtitle' && item.status === 'ready').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
const subtitleCues = Number(subtitle?.metadata?.cueCount || 0);
const srtKey = subtitle ? (subtitle.metadata?.srtObjectKey || String(subtitle.object_key || '').replace(/\.json$/i, '.srt')) : '';
check(
  '字幕已生成有效时间轴',
  Boolean(subtitle) && subtitleCues > 0 && Boolean(srtKey) && existsSync(resolve(mediaRoot, srtKey)),
  subtitle ? `cueCount=${subtitleCues}，srt=${existsSync(resolve(mediaRoot, srtKey)) ? '存在' : '缺失'}` : '没有字幕资产',
);

const composition = assets.filter(item => item.type === 'video' && item.status === 'ready').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
if (!composition) {
  check('存在合成成片', false, '没有 ready 的 video 资产');
} else {
  const meta = composition.metadata || {};
  const file = resolve(mediaRoot, composition.object_key);
  check('成片文件存在', existsSync(file), composition.object_key);
  check('成片包含视频流与音轨', meta.probe?.hasVideo === true && meta.probe?.hasAudio === true, `video=${meta.probe?.hasVideo} audio=${meta.probe?.hasAudio}`);
  if (acceptance) {
    check(
      '成片覆盖完整镜头时间轴',
      Math.abs(Number(composition.duration_ms) - shotTotal) <= 100,
      `成片 ${composition.duration_ms}ms / 镜头合计 ${shotTotal}ms（旁白被裁切到 ${meta.audioDurationMs ?? '?'}ms 原音频的开头）`,
    );
  } else {
    check(
      '成片时长等于音频时长',
      Boolean(audio) && Math.abs(Number(composition.duration_ms) - Number(audio.duration_ms)) <= 100,
      `成片 ${composition.duration_ms}ms / 音频 ${audio?.duration_ms ?? '无'} ms`,
    );
  }
  if (file && existsSync(file) && !meta.probe) {
    const probed = probe(file);
    if (probed) check('ffprobe 复核成片', probed.hasVideo && probed.hasAudio, `${probed.durationMs}ms ${probed.width}x${probed.height}`);
  }
  const overlays = Array.isArray(meta.textOverlays) ? meta.textOverlays : [];
  check('成片记录了后期文字叠加', overlays.length > 0, overlays.length ? overlays.map(item => `"${item.text}"@${item.startSeconds.toFixed(2)}s`).join('、') : '没有 drawtext 叠加记录');
  check(
    '成片烧录了字幕',
    meta.subtitles?.applied === true,
    meta.subtitles?.applied ? `cueCount=${meta.subtitles.cueCount}` : `未烧录（${meta.subtitles?.reason || '未记录'}）`,
  );
}

const forbidden = shots.filter(shot => {
  const spec = parseJson(shot.generation_spec_json);
  return Array.isArray(spec.mustNotShow) && spec.mustNotShow.length > 0;
});
check('镜头写入了 mustNotShow 约束', forbidden.length === shots.length && shots.length > 0, `${forbidden.length}/${shots.length} 个镜头有禁止项`);

manualChecks.push('第 6 镜（电子屏停在 23:17）：打开成片对应时间段，确认 23:17 叠加在电子屏位置而不是画面空白处。');
manualChecks.push('第 7 镜（隧道轰鸣）：确认画面中没有出现列车实体。');
manualChecks.push('第 8/9 镜（广播女声）：确认画面中没有出现女人实体，站台保持无人。');
manualChecks.push('人物一致性：逐镜对比沈砚的脸型、发型、服装是否一致。');
manualChecks.push('字幕：确认成片底部字幕与旁白内容一致、无乱码。');
manualChecks.push('音频：确认成片包含旁白，且没有出现音画错位。');

printResults(results);
console.log('');
console.log('需要人工确认的项目（脚本无法判断内容语义）');
console.log('-'.repeat(72));
manualChecks.forEach(item => console.log(`  · ${item}`));

const failures = results.filter(item => item.level === 'fail');
console.log('');
console.log(`结果：${results.filter(item => item.level === 'pass').length} 项通过，${results.filter(item => item.level === 'warn').length} 项警告，${failures.length} 项失败。`);
console.log('本脚本为只读检查，没有修改数据库或媒体文件。');
db.close();
process.exit(failures.length ? 1 : 0);

function printResults(items) {
  const width = Math.max(...items.map(item => displayWidth(item.name)), 10);
  for (const item of items) {
    const label = item.level === 'pass' ? '通过' : item.level === 'warn' ? '警告' : '失败';
    const pad = ' '.repeat(Math.max(1, width - displayWidth(item.name)));
    console.log(`${label}  ${item.name}${pad}  ${item.detail || ''}`);
  }
}

function displayWidth(value) {
  return Array.from(String(value)).reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
}

function pickProject(database, hint) {
  const rows = database.prepare('SELECT * FROM projects').all();
  if (hint) {
    const matched = rows.find(row => row.id === hint) || rows.filter(row => row.title === hint).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    if (matched) return matched;
    return null;
  }
  return rows.filter(row => row.active_storyboard_plan_id).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]
    || rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

function schemaVersion(database) {
  const row = database.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
  return row?.value ?? 0;
}

function openDatabase(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return new DatabaseSync(path);
  }
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function probe(file) {
  const result = spawnSync(ffprobePath, [
    '-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-show_entries', 'format=duration', '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout);
    return {
      hasVideo: (payload.streams || []).some(stream => stream.codec_type === 'video'),
      hasAudio: (payload.streams || []).some(stream => stream.codec_type === 'audio'),
      width: Number((payload.streams || []).find(stream => stream.codec_type === 'video')?.width || 0),
      height: Number((payload.streams || []).find(stream => stream.codec_type === 'video')?.height || 0),
      durationMs: Math.round(Number(payload.format?.duration || 0) * 1000),
    };
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`验收无法继续：${message}`);
  process.exit(2);
}
