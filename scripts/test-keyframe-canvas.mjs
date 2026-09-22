#!/usr/bin/env node
/**
 * 对照实验：场景图当画布（官方 Qwen-Image-Edit 2511 接线），角色三视图当参考图 2。
 * 用法：node scripts/test-keyframe-canvas.mjs <seed> <steps> <flux|fixed> <short|app> [elevated|side-45]
 *   flux  = FluxKontextImageScale（官方 2511 模板的缩放）
 *   fixed = ImageScale 到 576x1024（本项目工作流的缩放）
 *   app   = 用数据库里最近一次真实任务提交的完整提示词/负向提示词
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const seed = Number(process.argv[2] || 1897949153);
const steps = Number(process.argv[3] || 20);
const scaleMode = process.argv[4] || 'flux';
const promptMode = process.argv[5] || 'short';
const variant = process.argv[6] || 'elevated';
const negativeMode = process.argv[7] || 'app';

const root = resolve(import.meta.dirname, '..');
const env = readDotEnv(resolve(root, '.env'));
const baseUrl = String(env.COMFYUI_BASE_URL || '').replace(/\/+$/, '');
const inputDir = 'wenying/6a05775b-e0a3-4f6c-a93d-fee1e45f8a9e';
const character = `${inputDir}/reference_character_character_4032e776df99_three-view_1-0.png`;
const sceneFiles = {
  elevated: `${inputDir}/reference_scene_scene_4811db94ed79_elevated_4-1271845727-abdb3f49.png`,
  'side-45': `${inputDir}/reference_scene_scene_4811db94ed79_side-45_3-1271845727-0f8aaf8c.png`,
};
const canvas = sceneFiles[variant] || sceneFiles.elevated;
const alternateVariant = variant === 'elevated' ? 'side-45' : 'elevated';
const alternateScene = sceneFiles[alternateVariant];

const shortPositive = [
  '【Reference Image Roles / 参考图关系】',
  `Reference Image 1: Environment canvas — this is the base image being edited (${variant}).`,
  'Keep its location, architecture, terrain, spatial layout, main-object positions, scale, materials, lighting atmosphere and color palette.',
  'Edit this exact place in frame: the result must remain the same location.',
  'Reference Image 2: Character design reference (three-view character sheet).',
  "Use this image only to preserve the character's identity, face, hairstyle, costume, accessories, body proportions and colors.",
  'Do not reproduce its multiple-view layout, repeated character figures, plain studio background, labels or borders.',
  `Reference Image 3: Additional environment view of the same location (${alternateVariant}).`,
  'Use it to keep the architecture, terrain, spatial layout and main-object positions consistent across camera angles.',
  '',
  '【最终关键帧】',
  'Add the character from Reference Image 2 into the plaza shown in Reference Image 1.',
  '角色：张元，低头看着手中一颗彩色石头，用手指转动石头，期待且疑惑。',
  '角色位于画面前景石板广场的人群中，与场景透视、比例、光照和接触阴影一致。',
  '镜头：中景，平视，50mm，角色位于画面右三分线。',
  '日式动画质感，干净线条，色彩明快。生成单张电影感关键帧，不要拼贴、分屏或多格。',
].join('\n');
const shortNegative = '分格，多格漫画，拼贴，上下分屏，左右分屏，重复人物，排版，可读文字，字幕，水印，边框，collage，split screen，multiple frames，低质量，模糊，面部变形，解剖结构错误，多余手指，手部畸形，背景变化，光照不一致，角色悬浮，比例错误';

const appPrompt = ['app', 'apptrim', 'concise'].includes(promptMode) ? latestAppPrompt() : null;
const concisePositive = [
  '【Reference Image Roles / 参考图关系】',
  `Reference Image 1: Environment canvas — this is the base image being edited (${variant}).`,
  'Keep its location, architecture, terrain, spatial layout, main-object positions, scale, materials, lighting atmosphere and color palette.',
  'Edit this exact place in frame: the result must remain the same location.',
  'Reference Image 2: Character design reference (three-view character sheet).',
  "Use this image only to preserve the character's identity, face, hairstyle, costume, accessories, body proportions and colors.",
  'Do not reproduce its multiple-view layout, repeated character figures, plain studio background, labels or borders.',
  `Reference Image 3: Additional environment view of the same location (${alternateVariant}).`,
  'Use it to keep the architecture, terrain, spatial layout and main-object positions consistent across camera angles.',
  'Add the character from the character reference into the environment canvas as a newly composed subject.',
  'The character must match the scene perspective, scale, ground contact, lighting and shadows.',
  '',
  '【最终关键帧】',
  '【画面内容】',
  '角色：张元。动作：张元位于人群中，身体基本保持站立，低头看向手中的一颗彩色石头，用手指反复转动、摩挲石头',
  '道具与画面要素：张元手中有一颗彩色石头，面部显出期待与疑问',
  '【角色与环境关系】',
  '张元位于人群聚集的石板广场中，与场景透视、比例、地面接触、光照和阴影一致；空间位置与构图：三分法，张元置于画面右三分线，左侧保留人群与广场的负空间',
  '【镜头】',
  '景别：中景；机位：平视；镜头运动：固定镜头；焦距：50mm；构图：三分法，张元置于画面右三分线，左侧保留人群与广场的负空间',
  '【光照】',
  '沿用场景参考图的主光方向、色温、环境光和阴影方向；人物受光、接触阴影和反射色必须与环境一致',
  '【画面风格】',
  '日式动画质感，线条干净，色彩明快通透，玄幻世界氛围，细节柔和且富有手绘温度。',
  '【一致性要求】',
  '保持角色外观与参考图一致；保持场景结构与参考图一致；角色正确融入场景透视、光照和接触阴影；只生成一张画面',
].join('\n');

const positive = promptMode === 'concise'
  ? concisePositive
  : promptMode === 'apptrim'
  ? stripEntitySections(appPrompt?.prompt || '')
  : (appPrompt?.prompt || shortPositive);
const negative = negativeMode === 'short' ? shortNegative : (appPrompt?.negativePrompt || shortNegative);

const scaleNodes = scaleMode === 'fixed'
  ? {
      5: { class_type: 'ImageScale', inputs: { image: ['10', 0], upscale_method: 'lanczos', width: 576, height: 1024, crop: 'disabled' } },
      15: { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['4', 0] } },
      canvasSource: ['5', 0],
    }
  : {
      5: { class_type: 'FluxKontextImageScale', inputs: { image: ['10', 0] } },
      15: { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['4', 0] } },
      canvasSource: ['5', 0],
    };

const workflow = {
  1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image-edit-2511-Q4_K_M.gguf' } },
  2: { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', type: 'qwen_image' } },
  4: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  10: { class_type: 'LoadImage', inputs: { image: canvas } },
  11: { class_type: 'LoadImage', inputs: { image: character } },
  14: { class_type: 'LoadImage', inputs: { image: alternateScene } },
  5: scaleNodes[5],
  15: scaleNodes[15],
  6: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: positive, vae: ['4', 0], image1: scaleNodes.canvasSource, image2: ['11', 0], image3: ['14', 0] } },
  7: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: negative, vae: ['4', 0], image1: scaleNodes.canvasSource, image2: ['11', 0], image3: ['14', 0] } },
  12: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['6', 0], reference_latents_method: 'index_timestep_zero' } },
  13: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['7', 0], reference_latents_method: 'index_timestep_zero' } },
  50: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3.1, model: ['1', 0] } },
  60: { class_type: 'CFGNorm', inputs: { strength: 1, pre_cfg: false, model: ['50', 0] } },
  3: { class_type: 'KSampler', inputs: { seed, steps, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['60', 0], positive: ['12', 0], negative: ['13', 0], latent_image: ['15', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: `wenying/test-${scaleMode}-${promptMode}-${variant}`, images: ['8', 0] } },
};

const queued = await fetch(baseUrl + '/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'wenying-canvas-test' }),
});
const queuedBody = await queued.json();
if (!queued.ok) {
  console.error('提交失败', queued.status, JSON.stringify(queuedBody).slice(0, 2000));
  process.exit(1);
}
const promptId = queuedBody.prompt_id;
console.log(`已提交 promptId=${promptId} seed=${seed} steps=${steps} scale=${scaleMode} prompt=${promptMode} canvas=${variant}`);

const deadline = Date.now() + 30 * 60 * 1000;
let entry = null;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 4000));
  const body = await (await fetch(`${baseUrl}/history/${promptId}`)).json();
  entry = body?.[promptId];
  if (entry?.outputs && Object.keys(entry.outputs).length) break;
  if (entry?.status?.status_str === 'error') break;
}
if (!entry) {
  console.error('超时，未拿到历史记录');
  process.exit(1);
}
if (entry.status?.status_str === 'error') {
  console.error('执行报错', JSON.stringify(entry.status).slice(0, 3000));
  process.exit(1);
}

const outDir = resolve(root, 'tmp-test');
mkdirSync(outDir, { recursive: true });
for (const output of Object.values(entry.outputs || {})) {
  for (const image of output.images || []) {
    const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
    const response = await fetch(`${baseUrl}/view?${params}`);
    const target = resolve(outDir, image.filename);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    console.log('已保存', target);
  }
}

function latestAppPrompt() {
  const db = new DatabaseSync(resolve(root, 'data', 'wenying.sqlite'), { readOnly: true });
  const row = db.prepare(
    "SELECT metadata_json FROM media_assets WHERE type LIKE '%keyframe%' ORDER BY created_at DESC LIMIT 1",
  ).get();
  if (!row) return null;
  const meta = JSON.parse(row.metadata_json || '{}');
  return { prompt: meta.prompt, negativePrompt: meta.negativePrompt };
}

function stripEntitySections(prompt) {
  return prompt
    .split(/\n\n/)
    .filter(block => !/^【(角色|场景)】/.test(block.trim()))
    .join('\n\n');
}

function readDotEnv(path) {
  const result = {};
  let contents = '';
  try {
    contents = readFileSync(path, 'utf8');
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
