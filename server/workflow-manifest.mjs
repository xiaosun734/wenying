import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadWorkflowManifest(path, { required = false } = {}) {
  if (!path) {
    if (required) throw new WorkflowManifestError('未配置工作流 manifest', 'WORKFLOW_MANIFEST_REQUIRED');
    return null;
  }
  try {
    const content = await readFile(resolve(path), 'utf8');
    const manifest = JSON.parse(content);
    validateWorkflowManifest(manifest);
    return manifest;
  } catch (error) {
    if (error instanceof WorkflowManifestError) throw error;
    throw new WorkflowManifestError(`无法读取工作流 manifest：${error.message}`, 'WORKFLOW_MANIFEST_INVALID', error);
  }
}

export function validateWorkflowManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new WorkflowManifestError('工作流 manifest 必须是 JSON 对象', 'WORKFLOW_MANIFEST_INVALID');
  }
  if (!manifest.profileId || !manifest.mode) {
    throw new WorkflowManifestError('工作流 manifest 必须包含 profileId 和 mode', 'WORKFLOW_MANIFEST_INVALID');
  }
  for (const key of ['positivePrompt', 'negativePrompt', 'startImage', 'width', 'height', 'frames', 'fps', 'denoise', 'filenamePrefix']) {
    if (manifest[key] !== undefined) validateFieldSpec(manifest[key], key);
  }
  if (manifest.seedInputs !== undefined) {
    if (!Array.isArray(manifest.seedInputs) || !manifest.seedInputs.length) throw new WorkflowManifestError('seedInputs 必须是非空数组', 'WORKFLOW_MANIFEST_INVALID');
    manifest.seedInputs.forEach((item, index) => validateFieldSpec(item, `seedInputs[${index}]`));
  }
  if (manifest.referenceImages !== undefined) {
    if (!Array.isArray(manifest.referenceImages) || !manifest.referenceImages.length) throw new WorkflowManifestError('referenceImages 必须是非空数组', 'WORKFLOW_MANIFEST_INVALID');
    manifest.referenceImages.forEach((item, index) => validateFieldSpec(item, `referenceImages[${index}]`));
  }
  return manifest;
}

export function applyWorkflowManifest(workflow, manifest, values = {}) {
  if (!manifest) return { applied: [], missing: [] };
  const applied = [];
  const mappings = [
    ['positivePrompt', values.positivePrompt],
    ['negativePrompt', values.negativePrompt],
    ['startImage', values.startImage],
    ['width', values.width],
    ['height', values.height],
    ['frames', values.frames],
    ['fps', values.fps],
    ['denoise', values.denoise],
  ];
  for (const [key, value] of mappings) {
    if (manifest[key] === undefined || value === undefined || value === null) continue;
    setManifestField(workflow, manifest[key], value, key);
    applied.push(key);
  }
  if (manifest.seedInputs && values.seed !== undefined && values.seed !== null) {
    manifest.seedInputs.forEach((item, index) => {
      const seed = Number(item.increment || 0) + Number(values.seed);
      setManifestField(workflow, item, seed, `seedInputs[${index}]`);
    });
    applied.push('seedInputs');
  }
  // 多图参考：按声明顺序把上传后的文件名写进各自的 LoadImage 节点。
  // 单图工作流不声明 referenceImages，这里自然跳过。
  if (Array.isArray(manifest.referenceImages) && Array.isArray(values.referenceImages)) {
    manifest.referenceImages.forEach((item, index) => {
      const value = values.referenceImages[index];
      if (value === undefined || value === null || value === '') return;
      setManifestField(workflow, item, value, `referenceImages[${index}]`);
      applied.push(`referenceImages[${index}]`);
    });
  }
  if (manifest.startImageConnection && values.startImage !== undefined) {
    validateConnection(workflow, manifest.startImageConnection);
    applied.push('startImageConnection');
  }
  if (manifest.outputNode && !workflow[String(manifest.outputNode)]) {
    throw new WorkflowManifestError(`输出节点 ${manifest.outputNode} 不存在`, 'WORKFLOW_MANIFEST_NODE_MISSING');
  }
  if (manifest.requiresStartImage && !values.startImage) {
    throw new WorkflowManifestError('该工作流要求首帧图片，但当前请求未提供', 'WORKFLOW_START_IMAGE_REQUIRED');
  }
  return { applied, missing: [] };
}

export function validateWorkflowForManifest(workflow, manifest) {
  if (!manifest) return;
  // 先根据节点形态判断“工作流与 manifest 是否配对”，配对失败时这条报错最准确；
  // 配对正确后再逐个字段核对节点是否存在，防止工作流本身被改坏。
  validateManifestAgainstWorkflow(workflow, manifest);
  for (const [key, spec] of fieldSpecsOf(manifest)) {
    if (!workflow[String(spec.node)]) {
      throw new WorkflowManifestError(`manifest 字段 ${key} 指向不存在的节点 ${spec.node}`, 'WORKFLOW_MANIFEST_NODE_MISSING');
    }
    if (spec.field && workflow[String(spec.node)]?.inputs && !(spec.field in workflow[String(spec.node)].inputs)) {
      throw new WorkflowManifestError(`manifest 字段 ${key} 指向不存在的输入 ${spec.node}.${spec.field}`, 'WORKFLOW_MANIFEST_FIELD_MISSING');
    }
  }
  if (manifest.startImageConnection) validateConnection(workflow, manifest.startImageConnection);
  if (manifest.outputNode && !workflow[String(manifest.outputNode)]) {
    throw new WorkflowManifestError(`输出节点 ${manifest.outputNode} 不存在`, 'WORKFLOW_MANIFEST_NODE_MISSING');
  }
}

function validateManifestAgainstWorkflow(workflow, manifest) {
  const declared = normaliseMode(describeDeclaredMode(manifest));
  const inferred = inferWorkflowMode(workflow);
  if (inferred.mode !== 'unknown' && declared && declared !== inferred.mode) {
    throw new WorkflowManifestError(
      `manifest ${manifest.profileId} 声明 mode=${declared}，但工作流实际是 ${inferred.mode}。`
      + '请检查 COMFYUI_*_WORKFLOW_PATH 与 COMFYUI_*_WORKFLOW_MANIFEST_PATH 是否配对。',
      'WORKFLOW_MANIFEST_MODE_MISMATCH',
      { declared, inferred: inferred.mode, classTypes: inferred.classTypes },
    );
  }
  const requirement = modeRequirement(declared);
  if (!requirement) return;
  if (requirement.requiresStartImage && !manifestHasField(manifest, 'startImage') && !manifest.startImageConnection) {
    throw new WorkflowManifestError(
      `manifest ${manifest.profileId} 声明 mode=${declared}，但没有配置 startImage 或 startImageConnection`,
      'WORKFLOW_MANIFEST_MODE_FIELD_MISSING',
    );
  }
  for (const key of requirement.requires) {
    if (!manifestHasField(manifest, key)) {
      throw new WorkflowManifestError(
        `manifest ${manifest.profileId} 声明 mode=${declared}，但缺少必需字段 ${key}`,
        'WORKFLOW_MANIFEST_MODE_FIELD_MISSING',
      );
    }
  }
  // 工作流本身支持改写这些参数，但 manifest 没把映射声明出来时，运行时配置
  // （KEYFRAME_DENOISE / FRAMES / FPS）会被工作流里的默认值静默吞掉。
  if (requirement.requiresDenoise && workflowHasInput(workflow, ['ksampler', 'ksampleradvanced'], 'denoise') && !manifestHasField(manifest, 'denoise')) {
    throw new WorkflowManifestError(
      `工作流有 denoise 输入，但 manifest ${manifest.profileId} 没有声明 denoise 映射，KEYFRAME_DENOISE 会被忽略`,
      'WORKFLOW_MANIFEST_MODE_FIELD_MISSING',
    );
  }
  if (requirement.requiresFramesInput && workflowHasInput(workflow, LENGTH_INPUT_NODES, 'length') && !manifestHasField(manifest, 'frames')) {
    throw new WorkflowManifestError(
      `工作流有 length 输入，但 manifest ${manifest.profileId} 没有声明 frames 映射，帧数配置会被忽略`,
      'WORKFLOW_MANIFEST_MODE_FIELD_MISSING',
    );
  }
  if (requirement.requiresFramesInput && workflowHasInput(workflow, ['createvideo'], 'fps') && !manifestHasField(manifest, 'fps')) {
    throw new WorkflowManifestError(
      `工作流有 fps 输入，但 manifest ${manifest.profileId} 没有声明 fps 映射，帧率配置会被忽略`,
      'WORKFLOW_MANIFEST_MODE_FIELD_MISSING',
    );
  }
}

function workflowHasInput(workflow, classTypes, field) {
  return Object.values(workflow || {}).some(node => (
    classTypes.includes(String(node?.class_type || '').toLowerCase())
    && node?.inputs
    && field in node.inputs
  ));
}

function setManifestField(workflow, spec, value, label) {
  validateFieldSpec(spec, label);
  const node = workflow[String(spec.node)];
  if (!node?.inputs || !(spec.field in node.inputs)) {
    throw new WorkflowManifestError(`manifest 字段 ${label} 指向不存在的输入 ${spec.node}.${spec.field}`, 'WORKFLOW_MANIFEST_FIELD_MISSING');
  }
  node.inputs[spec.field] = value;
}

function validateConnection(workflow, connection) {
  if (!connection?.node || !connection.input || !Array.isArray(connection.source)) {
    throw new WorkflowManifestError('startImageConnection 定义无效', 'WORKFLOW_MANIFEST_INVALID');
  }
  const node = workflow[String(connection.node)];
  if (!node?.inputs) throw new WorkflowManifestError(`连接目标节点 ${connection.node} 不存在`, 'WORKFLOW_MANIFEST_NODE_MISSING');
  node.inputs[connection.input] = [...connection.source];
  if (!workflow[String(connection.source[0])]) {
    throw new WorkflowManifestError(`连接源节点 ${connection.source[0]} 不存在`, 'WORKFLOW_MANIFEST_NODE_MISSING');
  }
}

function validateFieldSpec(spec, label) {
  if (!spec || typeof spec !== 'object' || !spec.node || !spec.field) {
    throw new WorkflowManifestError(`${label} 必须包含 node 和 field`, 'WORKFLOW_MANIFEST_INVALID');
  }
}

const MODE_CONTRACT = Object.freeze({
  t2i: { requiresStartImage: false, requires: ['positivePrompt', 'negativePrompt', 'seedInputs'] },
  i2i: { requiresStartImage: true, requiresDenoise: true, requires: ['positivePrompt', 'negativePrompt', 'seedInputs', 'startImage'] },
  i2v: { requiresStartImage: true, requiresFramesInput: true, requires: ['positivePrompt', 'negativePrompt', 'seedInputs', 'startImage'] },
});

const LENGTH_INPUT_NODES = ['wan22imagetovideolatent', 'wanimagetovideolatent', 'hunyuanvideolatent', 'emptylatentvideo', 'videolatent', 'emptylatentimage'];

const START_IMAGE_NODES = ['loadimage', 'loadimageoutput', 'etn_loadimage'];
// 文本编码节点：除了通用 CLIPTextEncode，Qwen-Image-Edit / Z-Image 等编辑模型
// 用 TextEncodeQwenImageEditPlus 这类“提示词 + 参考图”节点，同样属于文本编码环节。
const TEXT_ENCODE_NODES = ['cliptextencode', 'textencodeqwenimageeditplus', 'textencodeqwenimageedit', 'textencodezimageomni', 'textencodebooguedit'];
const VIDEO_OUTPUT_NODES = ['savevideo', 'savewebm', 'saveanimatedwebp', 'vhs_videocombine'];
const VIDEO_PIPELINE_NODES = ['wan22imagetovideolatent', 'wanimagetovideolatent', 'hunyuanvideolatent', 'emptylatentvideo', 'videolinearcfg', 'videolatent'];

/**
 * ComfyUI 的 API 格式工作流里，节点 class_type 直接暴露了工作流能力。
 * 用它反推工作流真实形态，可以和 manifest 声明的 mode 对照，避免把
 * “场景参考图”的 manifest 套到“图生视频”的工作流上而无人察觉。
 */
export function inferWorkflowMode(workflow) {
  const classTypes = new Set(
    Object.values(workflow || {})
      .map(node => String(node?.class_type || '').toLowerCase())
      .filter(Boolean),
  );
  const has = list => list.some(item => classTypes.has(item));
  const hasVideoOutput = list => [...classTypes].some(item => list.includes(item));
  const hasVideoPipeline = [...classTypes].some(item => VIDEO_PIPELINE_NODES.includes(item) || item.includes('imagetovideo'));
  const hasStartImage = has(START_IMAGE_NODES);
  const hasTextEncode = has(TEXT_ENCODE_NODES);

  // 只要有视频产出节点或视频链路节点，就认定为 i2v：即使缺少 LoadImage
  // 也仍然会把 t2i 的 manifest 判为不匹配，而不是放过。
  if (hasVideoOutput(VIDEO_OUTPUT_NODES) || hasVideoPipeline) {
    return { mode: 'i2v', confidence: 'high', classTypes: [...classTypes] };
  }
  // 有图片输入 + 文本编码 + 采样器 => 图生图；纯文生图不会有 LoadImage。
  if (hasStartImage && hasTextEncode && classTypes.has('ksampler')) {
    return { mode: 'i2i', confidence: 'high', classTypes: [...classTypes] };
  }
  if (hasTextEncode && classTypes.has('ksampler')) {
    return { mode: 't2i', confidence: 'high', classTypes: [...classTypes] };
  }
  return { mode: 'unknown', confidence: 'low', classTypes: [...classTypes] };
}

const MODE_ALIASES = Object.freeze({
  'keyframe-img2img': 'i2i',
  img2img: 'i2i',
  text2image: 't2i',
  image2video: 'i2v',
});

function normaliseMode(mode) {
  const value = String(mode || '').toLowerCase();
  return MODE_ALIASES[value] || value;
}

/**
 * 只读校验一组“工作流 + manifest”：返回反推出的工作流形态与 manifest 档案名。
 * 供启动自检和排障使用，不会提交任务。
 */
export async function verifyWorkflowPair(workflowPath, manifestPath) {
  if (!workflowPath) return { configured: false, mode: null, profileId: null };
  const contents = await readFile(resolve(workflowPath), 'utf8');
  const parsed = JSON.parse(contents);
  const workflow = parsed?.prompt && typeof parsed.prompt === 'object' && !Array.isArray(parsed.prompt)
    ? parsed.prompt
    : parsed;
  const manifest = manifestPath ? await loadWorkflowManifest(manifestPath, { required: true }) : null;
  validateWorkflowForManifest(workflow, manifest);
  const inferred = inferWorkflowMode(workflow);
  return {
    configured: true,
    mode: inferred.mode,
    confidence: inferred.confidence,
    declaredMode: normaliseMode(describeDeclaredMode(manifest)),
    profileId: manifest?.profileId || null,
  };
}

function modeRequirement(mode) {
  return MODE_CONTRACT[normaliseMode(mode)] || null;
}

function fieldSpecsOf(manifest) {
  const entries = [];
  for (const [key, spec] of Object.entries(manifest || {})) {
    if (Array.isArray(spec)) {
      spec.forEach((item, index) => {
        if (item && typeof item === 'object' && item.node && item.field) entries.push([`${key}[${index}]`, item]);
      });
      continue;
    }
    if (spec && typeof spec === 'object' && spec.node && spec.field) entries.push([key, spec]);
  }
  return entries;
}

function manifestHasField(manifest, key) {
  const spec = manifest?.[key];
  if (Array.isArray(spec)) return spec.length > 0 && spec.every(item => item?.node && item?.field);
  return Boolean(spec && typeof spec === 'object' && spec.node && spec.field);
}

function describeDeclaredMode(manifest) {
  return String(manifest?.mode || '').toLowerCase();
}

export class WorkflowManifestError extends Error {
  constructor(message, code = 'WORKFLOW_MANIFEST_ERROR', details = null) {
    super(message);
    this.name = 'WorkflowManifestError';
    this.code = code;
    this.details = details;
  }
}
