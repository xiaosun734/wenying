#!/usr/bin/env node
/**
 * 关键实验：不用场景图当画布（空 latent），只把场景图当参考条件，提示词只给镜头设计。
 * 看构图能不能由文字（景别/机位/焦距）决定，而空间风格仍来自场景参考图。
 * 用法：node scripts/probe-scene-plate.mjs <seed> <steps>
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
const sceneAlt = `${inputDir}/reference_scene_scene_4811db94ed79_side-45_3-1271845727-0f8aaf8c.png`;

const positive = [
  '以场景参考图里的这处宗门广场为同一地点，重新设计这个镜头的取景：',
  '景别：中景。机位：平视，轻微低机位。',
  '摄影机位于广场内部、东南侧，朝中央祭坛方向拍摄，35mm。',
  '祭坛位于画面后方，广场石板地面占据前景，远处宗门建筑作为背景。',
  '保持场景的建筑风格、祭坛结构、空间关系、材质、人群和紫蓝色光照不变。',
  '画面里不要出现主要角色。单张电影感画面。',
].join('\n');
const negative = '拼贴，分格，上下分屏，多格漫画，低质量，模糊，变形，文字，水印，俯拍全景，主要角色特写';

const workflow = {
  1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image-edit-2511-Q4_K_M.gguf' } },
  2: { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', type: 'qwen_image' } },
  4: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  50: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3.1, model: ['1', 0] } },
  60: { class_type: 'CFGNorm', inputs: { strength: 1, pre_cfg: false, model: ['50', 0] } },
  10: { class_type: 'LoadImage', inputs: { image: sceneWide } },
  11: { class_type: 'LoadImage', inputs: { image: sceneAlt } },
  5: { class_type: 'EmptySD3LatentImage', inputs: { width: 576, height: 1024, batch_size: 1 } },
  6: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: positive, vae: ['4', 0], image1: ['10', 0], image2: ['11', 0] } },
  12: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['6', 0], reference_latents_method: 'index_timestep_zero' } },
  7: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: negative, vae: ['4', 0], image1: ['10', 0], image2: ['11', 0] } },
  13: { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['7', 0], reference_latents_method: 'index_timestep_zero' } },
  3: { class_type: 'KSampler', inputs: { seed, steps, cfg: 4, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['60', 0], positive: ['12', 0], negative: ['13', 0], latent_image: ['5', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'wenying/test-empty-canvas-scene', images: ['8', 0] } },
};

const queued = await fetch(baseUrl + '/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: workflow, client_id: 'wenying-scene-plate-test' }),
});
const queuedBody = await queued.json();
if (!queued.ok) {
  console.error('提交失败', queued.status, JSON.stringify(queuedBody).slice(0, 2000));
  process.exit(1);
}
const promptId = queuedBody.prompt_id;
console.log(`已提交 promptId=${promptId} seed=${seed} steps=${steps}`);

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
  console.error('失败', JSON.stringify(entry?.status || 'timeout').slice(0, 2000));
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
