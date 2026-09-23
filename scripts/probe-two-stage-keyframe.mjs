#!/usr/bin/env node
/**
 * 验证"导演/摄影机"两段式关键帧：
 *   第 1 段：场景图当画布 + 只有镜头设计 → 重拍出该镜头的空场景板
 *   第 2 段：空场景板当画布 + 角色三视图当身份参考 + 只有动作 → 角色入画
 * 用法：node scripts/probe-two-stage-keyframe.mjs <seed> <steps>
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const seed = Number(process.argv[2] || 20260922);
const steps = Number(process.argv[3] || 20);
const root = resolve(import.meta.dirname, '..');
const env = readDotEnv(resolve(root, '.env'));
const baseUrl = String(env.COMFYUI_BASE_URL || '').replace(/\/+$/, '');

const inputDir = 'wenying/6a05775b-e0a3-4f6c-a93d-fee1e45f8a9e';
const sceneWide = `${inputDir}/reference_scene_scene_4811db94ed79_elevated_4-1271845727-abdb3f49.png`;
const character = `${inputDir}/reference_character_character_4032e776df99_three-view_1-0.png`;

// 第 1 段：只给镜头设计，不给角色。目标是让模型"重新拍"，而不是"复制这张图"。
const scenePlatePositive = [
  '用同一处地点重新拍一张：',
  '景别：中景。机位：平视，轻微低机位。',
  '摄影机进入广场内部，位于广场东南侧，朝中央祭坛方向拍摄，35mm。',
  '祭坛位于人物后方，背景保留部分宗门建筑，远处弟子形成层次。',
  '保持建筑风格、祭坛结构、空间关系、材质、人气和光照色彩不变。',
  '画面里不要出现主要角色，只保留广场、祭坛、人群与建筑。',
  '单张电影感画面，不要拼贴、分屏或多格。',
].join('\n');
const scenePlateNegative = '拼贴，分格，上下分屏，多格漫画，低质量，模糊，变形，文字，水印，主要角色特写';

// 第 2 段：画布已经是该镜头的空场景板，只写"谁在做什么、怎么融进去"。
const characterPositive = [
  '把 Reference Image 2 中的少年放进这张画面里。',
  '他位于画面右侧三分线，站在广场的石板地面上，低头看着手中一颗彩色石头，用手指转动石头，神情期待而疑惑。',
  '保持画面已有的景别、机位、广场结构、人群、光照方向和色彩；人物与场景透视、比例、地面接触和阴影一致。',
  '单张电影感关键帧，不要拼贴、分屏或多格。',
].join('\n');
const characterNegative = '拼贴，分格，上下分屏，多格漫画，低质量，模糊，面部变形，解剖结构错误，多余手指，角色悬浮，比例错误，背景变化，光照不一致';

const workflow = {
  1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image-edit-2511-Q4_K_M.gguf' } },
  2: { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', type: 'qwen_image' } },
  4: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  50: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3.1, model: ['1', 0] } },
  60: { class_type: 'CFGNorm', inputs: { strength: 1, pre_cfg: false, model: ['50', 0] } },

  // ---- 第 1 段：重拍场景 ----
  10: { class_type: 'LoadImage', inputs: { image: sceneWide } },
  5: { class_type: 'ImageScale', inputs: { image: ['10', 0], upscale_method: 'lanczos', width: 576, height: 1024, crop: 'disabled' } },
  15: { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['4', 0] } },
  16: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: scenePlatePositive, vae: ['4', 0], image1: ['5', 0] } },
  17: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['16', 0], reference_latents_method: 'index_timestep_zero' } },
  18: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: scenePlateNegative, vae: ['4', 0], image1: ['5', 0] } },
  19: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['18', 0], reference_latents_method: 'index_timestep_zero' } },
  30: { class_type: 'KSampler', inputs: { seed, steps, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['60', 0], positive: ['17', 0], negative: ['19', 0], latent_image: ['15', 0] } },
  31: { class_type: 'VAEDecode', inputs: { samples: ['30', 0], vae: ['4', 0] } },
  32: { class_type: 'SaveImage', inputs: { filename_prefix: 'wenying/test-2stage-plate', images: ['31', 0] } },

  // ---- 第 2 段：角色入画 ----
  11: { class_type: 'LoadImage', inputs: { image: character } },
  33: { class_type: 'VAEEncode', inputs: { pixels: ['31', 0], vae: ['4', 0] } },
  6: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: characterPositive, vae: ['4', 0], image1: ['31', 0], image2: ['11', 0] } },
  12: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['6', 0], reference_latents_method: 'index_timestep_zero' } },
  7: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: characterNegative, vae: ['4', 0], image1: ['31', 0], image2: ['11', 0] } },
  13: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['7', 0], reference_latents_method: 'index_timestep_zero' } },
  3: { class_type: 'KSampler', inputs: { seed: seed + 1, steps, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['60', 0], positive: ['12', 0], negative: ['13', 0], latent_image: ['33', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'wenying/test-2stage-keyframe', images: ['8', 0] } },
};

const queued = await fetch(baseUrl + '/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'wenying-two-stage-test' }),
});
const queuedBody = await queued.json();
if (!queued.ok) {
  console.error('提交失败', queued.status, JSON.stringify(queuedBody).slice(0, 2000));
  process.exit(1);
}
const promptId = queuedBody.prompt_id;
console.log(`已提交 promptId=${promptId} seed=${seed} steps=${steps}（两段采样，耗时约为单段的两倍）`);

const deadline = Date.now() + 30 * 60 * 1000;
let entry = null;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 5000));
  const body = await (await fetch(`${baseUrl}/history/${promptId}`)).json();
  entry = body?.[promptId];
  if (entry?.outputs && Object.keys(entry.outputs).length) break;
  if (entry?.status?.status_str === 'error') break;
}
if (!entry || entry.status?.status_str === 'error') {
  console.error('失败', JSON.stringify(entry?.status || 'timeout').slice(0, 3000));
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
