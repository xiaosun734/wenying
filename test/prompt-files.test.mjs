import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { PROMPT_FILES, optionalPrompt, promptValue, renderPrompt, requiredPrompt } from '../server/prompt-config.mjs';

test('loads every prompt from its own file when no environment override exists', () => {
  for (const [name, relativePath] of Object.entries(PROMPT_FILES)) {
    const previous = process.env[name];
    delete process.env[name];
    try {
      const fullPath = resolve('prompts', relativePath);
      assert.equal(existsSync(fullPath), true, `${name} 缺少文件 ${relativePath}`);
      const value = promptValue(name);
      assert.ok(value.length > 0, `${name} 的文件不能为空`);
      assert.doesNotMatch(value, /^\s*#/m, `${name} 的维护注释不应进入实际提示词`);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test('keeps environment overrides and renders placeholders for file prompts', () => {
  const previous = process.env.LLM_DIRECTOR_USER_PROMPT_TEMPLATE;
  process.env.LLM_DIRECTOR_USER_PROMPT_TEMPLATE = '题材：{genre}；背景：{background}';
  try {
    assert.equal(
      renderPrompt(requiredPrompt('LLM_DIRECTOR_USER_PROMPT_TEMPLATE'), { genre: '悬疑', background: '雨夜' }),
      '题材：悬疑；背景：雨夜',
    );
  } finally {
    if (previous === undefined) delete process.env.LLM_DIRECTOR_USER_PROMPT_TEMPLATE;
    else process.env.LLM_DIRECTOR_USER_PROMPT_TEMPLATE = previous;
  }
  assert.match(optionalPrompt('COMFYUI_IMAGE_NEGATIVE_PROMPT'), /拼贴/);
});
