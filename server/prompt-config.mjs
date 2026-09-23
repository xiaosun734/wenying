import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 每个提示词变量对应一个独立文件。环境变量仍可覆盖文件，方便部署环境临时替换。
 */
export const PROMPT_FILES = Object.freeze({
  LLM_REWRITE_SYSTEM_PROMPT: 'rewrite/system.txt',
  LLM_REWRITE_USER_PROMPT_TEMPLATE: 'rewrite/user.txt',
  LLM_SHOT_SYSTEM_PROMPT: 'shot/system.txt',
  LLM_SHOT_USER_PROMPT_TEMPLATE: 'shot/user.txt',
  LLM_VISUAL_BIBLE_SYSTEM_PROMPT: 'visual-bible/system.txt',
  LLM_VISUAL_BIBLE_USER_PROMPT_TEMPLATE: 'visual-bible/user.txt',
  LLM_DIRECTOR_SYSTEM_PROMPT: 'director/system.txt',
  LLM_DIRECTOR_USER_PROMPT_TEMPLATE: 'director/user.txt',
  LLM_CAMERA_SYSTEM_PROMPT: 'camera/system.txt',
  LLM_CAMERA_USER_PROMPT_TEMPLATE: 'camera/user.txt',
  LLM_STORYBOARD_SYSTEM_PROMPT: 'storyboard/system.txt',
  LLM_STORYBOARD_USER_PROMPT_TEMPLATE: 'storyboard/user.txt',
  VIDEO_DEFAULT_PROMPT_TEMPLATE: 'video/default.txt',
  VIDEO_FALLBACK_SHOT_PROMPT_TEMPLATE: 'video/fallback-shot.txt',
  VIDEO_FINAL_FALLBACK_PROMPT_TEMPLATE: 'video/final-fallback.txt',
  COMFYUI_IMAGE_NEGATIVE_PROMPT: 'image/negative.txt',
  COMFYUI_NEGATIVE_PROMPT: 'video/negative.txt',
});

export function promptValue(name) {
  const environmentValue = String(process.env[name] || '').trim();
  if (environmentValue) return environmentValue;
  const relativePath = PROMPT_FILES[name];
  if (!relativePath) return '';
  const promptsRoot = process.env.PROMPTS_DIR
    ? (isAbsolute(process.env.PROMPTS_DIR) ? process.env.PROMPTS_DIR : resolve(process.cwd(), process.env.PROMPTS_DIR))
    : resolve(projectRoot, 'prompts');
  try {
    return stripPromptComments(readFileSync(resolve(promptsRoot, relativePath), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function stripPromptComments(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*#/.test(line))
    .join('\n')
    .trim();
}

export function requiredPrompt(name) {
  const value = promptValue(name);
  if (!value) {
    throw Object.assign(new Error(`未配置提示词：${name}`), { code: 'PROMPT_NOT_CONFIGURED' });
  }
  return value;
}

export function optionalPrompt(name) {
  return promptValue(name);
}

export function renderPrompt(template, values = {}) {
  return String(template || '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match
  ));
}
