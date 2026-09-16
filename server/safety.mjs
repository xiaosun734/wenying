const DEFAULT_BLOCKED_TERMS = [
  '儿童色情',
  '制作炸弹',
  '制作毒品',
  '自杀直播',
];

function blockedTerms() {
  const configured = String(process.env.SENSITIVE_WORDS || '')
    .split(',')
    .map(term => term.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_BLOCKED_TERMS;
}

export function auditText(text) {
  const value = String(text || '');
  const term = blockedTerms().find(candidate => value.includes(candidate));
  if (term) {
    return { ok: false, code: 'CONTENT_REVIEW_REJECTED', message: '当前内容无法生成，请调整相关文本' };
  }
  return { ok: true };
}

export function cleanSourceText(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function cleanGeneratedText(text) {
  return String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}
