#!/usr/bin/env node
/**
 * 单独试生成"内部中景机位"这张场景参考图（走真实的 t2i 图像工作流），
 * 确认它会补齐分镜需要的近景/中景机位，而不是把场景画成另一个地方。
 * 用法：node scripts/probe-scene-interior-view.mjs [entityId] [seed]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) continue;
  const value = match[2].trim().replace(/^["']|["']$/g, '');
  if (process.env[match[1]] === undefined) process.env[match[1]] = value;
}
for (const key of ['COMFYUI_WORKFLOW_PATH', 'COMFYUI_WORKFLOW_MANIFEST_PATH', 'COMFYUI_IMAGE_WORKFLOW_PATH', 'COMFYUI_IMAGE_WORKFLOW_MANIFEST_PATH', 'COMFYUI_KEYFRAME_WORKFLOW_PATH', 'COMFYUI_KEYFRAME_WORKFLOW_MANIFEST_PATH']) {
  if (process.env[key] && !/^([A-Za-z]:[\\/]|\/)/.test(process.env[key])) process.env[key] = resolve(root, process.env[key]);
}

const { createMediaProvider } = await import('../server/providers/media.mjs');
const { compileReferencePrompt, referenceVariants } = await import('../server/visual-assets.mjs');
const { buildImageNegativePrompt } = await import('../server/media-task.mjs');
const { DatabaseSync } = await import('node:sqlite');

const entityId = process.argv[2] || 'scene_4811db94ed79';
const seed = Number(process.argv[3] || 4242);

const raw = new DatabaseSync(resolve(root, process.env.DATABASE_PATH || 'data/wenying.sqlite'), { readOnly: true });
const bibleRow = raw.prepare('SELECT content_json, project_id FROM visual_bibles ORDER BY created_at DESC LIMIT 1').get();
const projectRow = raw.prepare('SELECT * FROM projects WHERE id = ?').get(bibleRow.project_id);
const content = JSON.parse(bibleRow.content_json);
const entity = [...(content.scenes || []), ...(content.characters || []), ...(content.props || [])].find(item => item.entityId === entityId);
if (!entity) {
  console.error('找不到实体', entityId);
  process.exit(1);
}
const variant = referenceVariants('scene').find(item => item.id === 'interior-medium');
// 直接走生产代码路径：内部中景变体自带 framing-first 提示词。
const prompt = compileReferencePrompt({ entity, kind: 'scene', visualBible: content, variant });
const provider = createMediaProvider();
const image = await provider.generateImage({
  project: { id: projectRow.id, title: projectRow.title, genre: projectRow.genre, background: projectRow.background },
  prompt,
  negativePrompt: buildImageNegativePrompt(provider, {}),
  negativeOverride: true,
  seed,
  filenamePrefix: `reference_scene_${entityId}_${variant.id}_probe`,
  width: 576,
  height: 1024,
  metadata: { probe: true, variantId: variant.id },
});
console.log('prompt:\n' + prompt + '\n');
console.log('objectKey:', image.objectKey);
console.log('本地文件:', resolve(root, 'data', 'media', image.objectKey));
console.log('promptId:', image.metadata?.promptId, 'seed:', image.metadata?.seed);
