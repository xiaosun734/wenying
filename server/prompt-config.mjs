export function requiredPrompt(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw Object.assign(new Error(`未配置提示词环境变量：${name}`), { code: 'PROMPT_NOT_CONFIGURED' });
  }
  return value;
}

export function optionalPrompt(name) {
  return String(process.env[name] || '').trim();
}

export function renderPrompt(template, values = {}) {
  return String(template || '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match
  ));
}
