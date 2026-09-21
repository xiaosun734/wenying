import { createHash } from 'node:crypto';

export const VISUAL_BIBLE_SCHEMA_VERSION = 2;
export const REFERENCE_ASSET_TYPES = Object.freeze({
  character: 'character_reference',
  scene: 'scene_reference',
  prop: 'prop_reference',
});

/**
 * Fields a user is allowed to lock down per visual entity. Character and scene
 * appearance is a production decision: the image model must not invent it.
 */
export const EDITABLE_ENTITY_FIELDS = Object.freeze({
  character: ['name', 'appearance', 'age', 'face', 'hair', 'body', 'costume'],
  scene: ['name', 'description', 'layout', 'lighting', 'colorPalette'],
  prop: ['name', 'description', 'material', 'state'],
});

/** Fields that change how an entity looks, so reference images must be redone. */
export const ENTITY_APPEARANCE_FIELDS = Object.freeze({
  character: ['appearance', 'age', 'face', 'hair', 'body', 'costume'],
  scene: ['description', 'layout', 'lighting', 'colorPalette'],
  prop: ['description', 'material', 'state'],
});

const UNSPECIFIED_CLAUSE = /未交代|未明确|尚未交代|未提及|不得虚构|无从确认|未给出|不作限定|未明|不明|不详|未确定|待定|未设定|未说明/;

/**
 * Removes clauses that only tell the model "this is unspecified". Those
 * clauses are meaningful for the writers room but act as noise, or worse as an
 * invitation to invent, for an image or video model.
 */
export function cleanEntityText(value) {
  return String(value || '')
    .split(/[；;。\n]+/)
    .map(item => item.trim())
    .filter(item => item && !UNSPECIFIED_CLAUSE.test(item))
    .join('；');
}

const REFERENCE_VARIANTS = {
  character: [
    {
      id: 'three-view',
      label: '全身三视图',
      instruction:
        '角色全身三视图：同一个人物从左到右依次排成三个完整全身视角——正面、侧面、背面。'
        + '三个视角的身高头身比、发型发色、五官、服装款式与配色必须完全一致，人物全身完整入镜，'
        + '纯色摄影棚背景，三视角等高并排、间距均匀，画面内没有任何文字与标注',
    },
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

/** 用户可选的画面风格 id → 实际写进提示词的风格描述。 */
export const VISUAL_STYLE_PROMPTS = Object.freeze({
  cinematic: '电影感写实风格，自然光影，低饱和电影调色，真实材质',
  realistic: '写实摄影风格，真实材质与自然光照，细节清晰',
  anime: '日系二维动画电影风格，干净线条，清晰色块，人物造型统一',
  chinese: '国风水墨动画风格，留白构图，淡彩渲染，东方线条',
  cyberpunk: '赛博朋克风格，霓虹高饱和，冷色科技光，强烈明暗对比',
});

/**
 * 统一解析“当前项目用什么画面风格”，避免各处硬编码“电影级写实”：
 * 视觉设定里已展开的风格描述 → 视觉设定记录的风格 id → 策划配置的风格 id → 中性兜底。
 */
export function resolveVisualStyle(visualBible = {}, configuration = {}) {
  const bible = normalizeVisualBibleContent(visualBible);
  const described = String(bible.style || '').trim();
  if (described) return described;
  const key = String(bible.visualStyle || configuration?.visualStyle || '').trim();
  if (key && VISUAL_STYLE_PROMPTS[key]) return VISUAL_STYLE_PROMPTS[key];
  if (key) return key;
  return '统一影视画面风格';
}

/** 场景专属词：出现在风格描述里说明这句是场景设定，不是全局画风。 */
const SCENE_BOUND_CLAUSE = /地铁|站台|隧道|列车|车厢|广播|电子屏|屏幕|站内|车站|月台|灰尘|雾气|地面|墙面|天花板|灯管|日光灯/;

/**
 * 角色参考图需要的人物风格描述：剔除场景专属句子，但保留 anime、冷色调这类真正的风格词。
 * 旧实现按中文句号切分再整句过滤，导致 “anime，悬疑，深夜冷色调，废弃地铁站…” 被整体丢弃，
 * 角色图会退回硬编码的写实风格，和场景图不是一套视觉。
 */
export function characterSafeStyle(value) {
  const clauses = String(value || '')
    .split(/[，,、；;。\n]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => !SCENE_BOUND_CLAUSE.test(item));
  return clauses.join('，') || '统一影视画面风格';
}

/** 人物身体部位：出现即说明这句在写人物，不属于场景描述。 */
const BODY_PART_CLAUSE = /后脑勺|脊背|后背|后颈|手掌|手心|指尖|手指|双手|身体|胸口|呼吸|视线|目光|眼神|眼睛|眉头|喉咙|耳朵|嘴角|脸色|双腿|脚步|手臂|肩膀|皮肤|发丝|衣角|脚踝|膝盖/;
/** 人物动作与心理：同样属于剧情，不属于场景描述。 */
const CHARACTER_ACTION_CLAUSE = /醒来|冷醒|睁开眼|闭上眼|坐起|站起身|站起来|抬起|转头|抬头|低头|伸手|扶着|按在|贴在|躺在|坐在|靠在|握着|拿着|听到|听见|想到|想起|记得|忘记|失忆|意识到|感到|感觉|恐惧|不安|慌张/;

/** “没有手机”这类否定句放在服装/外观字段里只会误导模型，直接剔除。 */
const NEGATION_CLAUSE = /^(没有|无|不带|未带|不带任何|并无)/;

/**
 * 角色外观字段清洗：去掉剧情动作、心理描写和否定句，只留下可拍摄的静态特征。
 * 旧数据里 appearance 常被写成“男性，失忆，被冷醒后从水泥地上坐起；手掌按在冰凉的黄色安全线上”，
 * 这些内容会直接进角色设定图提示词，导致模型自由发挥。
 */
export function characterSafeAppearance(value) {
  return String(value || '')
    .split(/[，,、；;。\n]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => !CHARACTER_ACTION_CLAUSE.test(item))
    .filter(item => !NEGATION_CLAUSE.test(item))
    .join('，');
}

/**
 * 场景描述清洗：只保留空间、陈设、材质、光线、氛围，去掉人物动作、身体感受和心理描写，
 * 以及任何提到具体角色名的句子。
 */
export function sceneSafeDescription(value, { characterNames = [] } = {}) {
  const names = (characterNames || []).map(name => String(name || '').trim()).filter(Boolean);
  return String(value || '')
    .split(/[，,、；;。\n]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => !BODY_PART_CLAUSE.test(item))
    .filter(item => !CHARACTER_ACTION_CLAUSE.test(item))
    .filter(item => !names.some(name => item.includes(name)))
    .join('，');
}

export function compileReferencePrompt({ entity, kind, visualBible = {}, configuration = {}, variant }) {
  const bible = normalizeVisualBibleContent(visualBible);
  const selectedVariant = variant || referenceVariants(kind)[0] || REFERENCE_VARIANTS.prop[0];
  const resolvedStyle = resolveVisualStyle(bible, configuration);
  const style = kind === 'character' ? characterSafeStyle(resolvedStyle) : resolvedStyle;
  const multiViewSheet = selectedVariant.id === 'three-view';
  const common = [
    `统一的${style}视觉风格`,
    '用途是后续关键帧和视频生成的角色/场景一致性参考',
    '空间结构、外观和服装不得自行改变',
    multiViewSheet
      ? '同一张画面内横向排列三个视角，不使用分格线、边框或文字标注，无文字水印'
      : '单张单画面，无分格，无拼贴，无多视图排版，无文字水印',
    selectedVariant.instruction,
  ];
  if (kind === 'character') {
    const safeFace = characterSafeAppearance(cleanEntityText(entity.face));
    const safeAppearance = characterSafeAppearance(cleanEntityText(entity.appearance));
    common.unshift([
      `${entity.name}，角色一致性设定`,
      cleanEntityText(entity.age) ? `年龄：${cleanEntityText(entity.age)}` : '',
      safeFace ? `面部与五官：${safeFace}` : '',
      safeAppearance && safeAppearance !== safeFace ? `外观：${safeAppearance}` : '',
      cleanEntityText(entity.hair) ? `发型发色：${cleanEntityText(entity.hair)}` : '',
      cleanEntityText(entity.body) ? `身高体型：${cleanEntityText(entity.body)}` : '',
      characterSafeAppearance(cleanEntityText(entity.costume)) ? `固定服装：${characterSafeAppearance(cleanEntityText(entity.costume))}` : '',
    ].filter(Boolean).join('；'));
  } else if (kind === 'scene') {
    const characterNames = (bible.characters || []).map(item => item.name);
    common.unshift([
      `${entity.name}，场景一致性母版`,
      entity.description ? `空间：${sceneSafeDescription(entity.description, { characterNames })}` : '',
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
