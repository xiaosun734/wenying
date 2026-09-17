import { createHash } from 'node:crypto';

export const VISUAL_BIBLE_SCHEMA_VERSION = 2;
export const REFERENCE_ASSET_TYPES = Object.freeze({
  character: 'character_reference',
  scene: 'scene_reference',
  prop: 'prop_reference',
});

const REFERENCE_VARIANTS = {
  character: [
    { id: 'front', label: '正面全身', instruction: '正面全身角色设定图，面部、发型、体型和服装完整可见，纯色摄影棚背景' },
    { id: 'three-quarter', label: '三分之二侧面', instruction: '三分之二侧面半身角色设定图，五官、发型和服装细节完整可见' },
    { id: 'profile', label: '侧面全身', instruction: '正侧面全身角色设定图，突出头身比例、服装剪裁和轮廓' },
    { id: 'face', label: '面部近景', instruction: '正面面部近景角色设定图，五官、肤色、眼神和发型细节清晰' },
  ],
  scene: [
    { id: 'master', label: '竖屏母版', instruction: '无人物竖屏场景母版，完整交代空间结构、主光源、色板和纵深' },
    { id: 'platform', label: '站台全景', instruction: '场景全景，清楚展示站台边界、立柱、电子屏和连接隧道的位置关系' },
    { id: 'tunnel', label: '隧道方向', instruction: '从站台看向隧道方向的空间参考，突出入口、纵深、亮度和不可见区域' },
    { id: 'screen', label: '关键道具位置', instruction: '场景俯视与视平线综合参考，准确交代电子屏、广播和其他关键道具的位置' },
  ],
  prop: [
    { id: 'isolated', label: '单体三视图', instruction: '道具单体设定图，正面、侧面和背面结构完整，纯色背景' },
    { id: 'detail', label: '材质细节', instruction: '道具材质与磨损细节近景，结构、颜色和表面状态清晰' },
    { id: 'scale', label: '尺度关系', instruction: '道具与人体或环境尺度的关系参考，位置和比例准确' },
    { id: 'state', label: '关键状态', instruction: '道具在剧情关键状态下的外观，状态变化清晰且可复现' },
  ],
};
export function normalizeVisualBibleContent(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const characters = normalizeEntities(source.characters, 'character', ['name', 'appearance', 'costume', 'age', 'face', 'hair', 'body']);
  const scenes = normalizeEntities(source.scenes, 'scene', ['name', 'description', 'layout', 'lighting', 'colorPalette']);
  const props = normalizeEntities(source.props || source.propReferences, 'prop', ['name', 'description', 'material', 'state']);
  return {
    ...source,
    schemaVersion: Math.max(VISUAL_BIBLE_SCHEMA_VERSION, Number(source.schemaVersion || 0)),
    characters,
    scenes,
    props,
    style: String(source.style || ''),
  };
}

function normalizeEntities(values, kind, fields) {
  if (!Array.isArray(values)) return [];
  const used = new Set();
  return values.map((value, index) => {
    const item = value && typeof value === 'object' ? { ...value } : {};
    const name = String(item.name || item.label || `${kind}-${index + 1}`).trim();
    let entityId = String(item.entityId || item.id || '').trim() || stableEntityId(kind, name, index);
    while (used.has(entityId)) entityId = `${entityId}-${index + 1}`;
    used.add(entityId);
    const output = { ...item, entityId, kind, name, locked: Boolean(item.locked) };
    for (const field of fields) {
      if (output[field] === undefined || output[field] === null) output[field] = '';
      if (typeof output[field] === 'string') output[field] = output[field].trim();
    }
    output.referenceAssetIds = uniqueStrings(item.referenceAssetIds);
    output.selectedReferenceAssetId = String(item.selectedReferenceAssetId || '').trim() || null;
    output.forbiddenElements = uniqueStrings(item.forbiddenElements);
    return output;
  });
}

export function getVisualEntity(content, kind, entityId) {
  const normalized = normalizeVisualBibleContent(content);
  const list = kind === 'character' ? normalized.characters : kind === 'scene' ? normalized.scenes : normalized.props;
  return list.find(item => item.entityId === entityId) || null;
}

export function updateVisualEntity(content, kind, entityId, patch = {}) {
  const normalized = normalizeVisualBibleContent(content);
  const key = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'props';
  normalized[key] = normalized[key].map(item => item.entityId === entityId ? { ...item, ...patch, entityId: item.entityId, kind } : item);
  return normalized;
}

export function visualBibleContentHash(content) {
  return createHash('sha256').update(stableStringify(normalizeVisualBibleContent(content))).digest('hex');
}

export function buildGenerationSignature(parts = {}) {
  const payload = {
    version: 1,
    ...parts,
    seedList: Array.isArray(parts.seedList) ? parts.seedList.map(String) : [],
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function referenceVariants(kind) {
  return structuredClone(REFERENCE_VARIANTS[kind] || REFERENCE_VARIANTS.prop);
}

export function compileReferencePrompt({ entity, kind, visualBible = {}, variant }) {
  const bible = normalizeVisualBibleContent(visualBible);
  const selectedVariant = variant || referenceVariants(kind)[0] || REFERENCE_VARIANTS.prop[0];
  const style = kind === 'character' ? characterSafeStyle(bible.style) : (bible.style || '电影级写实');
  const common = [
    `统一的${style}视觉风格`,
    '用途是后续关键帧和视频生成的角色/场景一致性参考',
    '空间结构、外观和服装不得自行改变',
    '单张单画面，无分格，无拼贴，无多视图排版，无文字水印',
    selectedVariant.instruction,
  ];
  if (kind === 'character') {
    common.unshift([
      `${entity.name}，角色一致性设定`,
      entity.age ? `年龄：${entity.age}` : '',
      entity.face || entity.appearance ? `面部与外观：${entity.face || entity.appearance}` : '',
      entity.hair ? `发型发色：${entity.hair}` : '',
      entity.body ? `身高体型：${entity.body}` : '',
      entity.costume ? `固定服装：${entity.costume}` : '',
      entity.description ? `补充：${entity.description}` : '',
    ].filter(Boolean).join('；'));
  } else if (kind === 'scene') {
    common.unshift([
      `${entity.name}，场景一致性母版`,
      entity.description ? `空间：${entity.description}` : '',
      entity.layout ? `空间方向与出入口：${entity.layout}` : '',
      entity.lighting ? `光源与照明：${entity.lighting}` : '',
      entity.colorPalette ? `色板：${entity.colorPalette}` : '',
    ].filter(Boolean).join('；'));
  } else {
    common.unshift([
      `${entity.name}，道具一致性设定`,
      entity.description ? `外观：${entity.description}` : '',
      entity.material ? `材质：${entity.material}` : '',
      entity.state ? `关键状态：${entity.state}` : '',
    ].filter(Boolean).join('；'));
  }
  const forbidden = Array.isArray(entity.forbiddenElements) ? entity.forbiddenElements.filter(Boolean) : [];
  if (forbidden.length) common.push(`禁止出现：${forbidden.join('、')}`);
  return common.filter(Boolean).join('；');
}

export function assetGenerationSignature(asset) {
  return String(asset?.generation_signature || asset?.generationSignature || asset?.metadata?.generationSignature || '').trim();
}

function stableEntityId(kind, name, index) {
  const digest = createHash('sha256').update(`${kind}:${name}:${index}`).digest('hex').slice(0, 12);
  return `${kind}_${digest}`;
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))];
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
function characterSafeStyle(value) {
  const clauses = String(value || '电影级写实')
    .split(/[；;。]/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => !/电子屏|屏幕|隧道|列车|广播|站台|地铁/.test(item));
  return clauses.join('；') || '电影级写实，冷色低照度，高反差，统一人物造型';
}