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
  for (const [key, spec] of Object.entries(manifest)) {
    if (!spec || typeof spec !== 'object' || !spec.node) continue;
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

export class WorkflowManifestError extends Error {
  constructor(message, code = 'WORKFLOW_MANIFEST_ERROR', details = null) {
    super(message);
    this.name = 'WorkflowManifestError';
    this.code = code;
    this.details = details;
  }
}