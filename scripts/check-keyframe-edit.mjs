#!/usr/bin/env node
/**
 * 关键帧「多图参考」工作流自检：
 *   1) 本地校验“工作流 + manifest”是否配对（模式、节点、字段）
 *   2) 连接 ComfyUI，检查工作流引用的模型文件是否已经下载
 *
 * 用法：
 *   node scripts/check-keyframe-edit.mjs
 *   node scripts/check-keyframe-edit.mjs <workflow.json> <manifest.json>
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyWorkflowPair } from '../server/workflow-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const [workflowArg, manifestArg] = process.argv.slice(2);
const workflowPath = resolve(root, workflowArg || 'workflows/qwen-image-edit-keyframe-api.json');
const manifestPath = resolve(root, manifestArg || 'workflows/manifests/qwen-image-edit-keyframe.json');

const MODEL_INPUTS = Object.freeze({
  unetloader: ['unet_name', ['diffusion_models']],
  // GGUF 权重的物理位置还是 models/diffusion_models，但 ComfyUI 的 diffusion_models
  // 目录只认 .safetensors 等扩展名，.gguf 要通过 unet_gguf / clip_gguf 这两个
  // 目录键才查得到（ComfyUI-GGUF 注册，扫描同一批目录、只保留 .gguf）。
  unetloadergguf: ['unet_name', ['unet_gguf', 'diffusion_models']],
  checkpointloadersimple: ['ckpt_name', ['checkpoints']],
  cliploader: ['clip_name', ['text_encoders']],
  cliploadergguf: ['clip_name', ['clip_gguf', 'text_encoders']],
  vaelloader: ['vae_name', ['vae']],
  loraloader: ['lora_name', ['loras']],
});

let failed = false;

const env = await readDotEnv(resolve(root, '.env'));
const baseUrl = String(env.COMFYUI_BASE_URL || '').replace(/\/+$/, '');

console.log('关键帧多图参考工作流自检');
console.log('  工作流：' + workflowPath);
console.log('  manifest：' + manifestPath);
console.log('  ComfyUI：' + (baseUrl || '(未配置 COMFYUI_BASE_URL)'));
console.log('');

try {
  const pair = await verifyWorkflowPair(workflowPath, manifestPath);
  console.log('✓ 工作流 / manifest 配对正常：mode=' + pair.mode + ' profile=' + pair.profileId);
} catch (error) {
  failed = true;
  console.error('× 工作流 / manifest 配对失败：' + error.message);
}

const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));

// 用 ComfyUI 的节点定义核对工作流里每个节点的输入字段，避免下载完模型才发现节点名或字段写错
if (baseUrl) {
  const specs = new Map();
  const problems = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const classType = String(node?.class_type || '');
    if (!classType) { problems.push('节点 ' + nodeId + ' 没有 class_type'); continue; }
    if (!specs.has(classType)) specs.set(classType, await fetchNodeSpec(baseUrl, classType));
    const spec = specs.get(classType);
    if (!spec) { problems.push('节点 ' + nodeId + ' 的 class_type ' + classType + ' 在当前 ComfyUI 上不存在'); continue; }
    const known = new Set([
      ...Object.keys(spec.input?.required || {}),
      ...Object.keys(spec.input?.optional || {}),
    ]);
    for (const key of Object.keys(node.inputs || {})) {
      if (!known.has(key)) problems.push('节点 ' + nodeId + ' (' + classType + ') 的输入 ' + key + ' 不在该节点的定义里');
    }
    for (const key of Object.keys(spec.input?.required || {})) {
      if (!(key in (node.inputs || {}))) problems.push('节点 ' + nodeId + ' (' + classType + ') 缺少必需输入 ' + key);
    }
  }
  if (problems.length) {
    failed = true;
    for (const problem of problems) console.error('× ' + problem);
  } else {
    console.log('✓ 工作流节点与当前 ComfyUI 的节点定义完全匹配（' + Object.keys(workflow).length + ' 个节点）');
  }
}

const required = collectModelRefs(workflow);
if (!required.length) console.log('· 工作流里没有需要检查的模型加载节点');
if (!baseUrl) {
  failed = true;
  console.error('× 无法检查模型文件：.env 缺少 COMFYUI_BASE_URL');
} else {
  const folders = new Map();
  for (const item of required) {
    for (const folder of item.folders) {
      if (!folders.has(folder)) folders.set(folder, await listModels(baseUrl, folder));
    }
  }
  for (const item of required) {
    const readable = item.folders.filter(folder => Array.isArray(folders.get(folder)));
    const hit = readable.find(folder => folders.get(folder)
      .some(name => String(name).toLowerCase() === item.file.toLowerCase()));
    if (hit) {
      console.log('✓ ' + hit + '/' + item.file);
    } else {
      failed = true;
      if (!readable.length) {
        console.error('× 无法读取模型目录：' + item.folders.join(' / '));
      } else {
        console.error('× 缺少模型：' + item.file + '（节点 ' + item.node + ' ' + item.classType + '，查过 ' + readable.join(' / ') + '）');
      }
    }
  }
}

console.log('');
if (failed) {
  console.log('下一步：');
  console.log('  1. 把上面缺的模型文件放到远程 ComfyUI 的 models/<对应目录>/');
  console.log('     · Qwen-Image-Edit-2511 主模型 qwen-image-edit-2511-Q4_K_M.gguf → models/diffusion_models/');
  console.log('     · Qwen2.5-VL-7B 文本编码器 Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf → models/text_encoders/');
  console.log('     · VAE 用已有的 qwen_image_vae.safetensors');
  console.log('     · GGUF 权重需要远程 ComfyUI 装好自定义节点 ComfyUI-GGUF（city96），否则 UnetLoaderGGUF / CLIPLoaderGGUF 不存在');
  console.log('  2. 全部 ✓ 之后，改 .env：');
  console.log('     COMFYUI_KEYFRAME_WORKFLOW_PATH=./workflows/qwen-image-edit-keyframe-api.json');
  console.log('     COMFYUI_KEYFRAME_WORKFLOW_MANIFEST_PATH=./workflows/manifests/qwen-image-edit-keyframe.json');
  console.log('     COMFYUI_KEYFRAME_DENOISE=1');
  console.log('     （编辑工作流把场景画布经 VAEEncode 接进 latent_image，denoise 应为 1；旧 img2img 工作流才用 0.82）');
  console.log('  3. 重启服务，日志出现 “ComfyUI keyframe 工作流：i2i / qwen-image-edit-2511-gguf-keyframe” 即生效');
  process.exitCode = 1;
} else {
  console.log('全部就绪：可以按上面的 .env 切换关键帧工作流。');
}

function collectModelRefs(workflow) {
  const refs = [];
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const mapping = MODEL_INPUTS[String(node?.class_type || '').toLowerCase()];
    if (!mapping) continue;
    const file = node?.inputs?.[mapping[0]];
    if (!file || typeof file !== 'string') continue;
    refs.push({ node: nodeId, classType: node.class_type, folders: mapping[1], file });
  }
  return refs;
}

async function fetchNodeSpec(baseUrl, classType) {
  try {
    const response = await fetch(baseUrl + '/object_info/' + encodeURIComponent(classType));
    if (!response.ok) return null;
    const info = await response.json();
    return info?.[classType] || null;
  } catch {
    return null;
  }
}

async function listModels(baseUrl, folder) {
  try {
    const response = await fetch(baseUrl + '/models/' + encodeURIComponent(folder));
    if (!response.ok) return null;
    const list = await response.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
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
    let value = match[2].trim().replace(/^["']|["']$/g, '');
    result[match[1]] = value;
  }
  return result;
}
