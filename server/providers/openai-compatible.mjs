import { cleanGeneratedText } from '../safety.mjs';
import { requiredPrompt, renderPrompt } from '../prompt-config.mjs';

export const PROMPT_VERSION = 'rewrite-v2';
export const SHOT_PROMPT_VERSION = 'shot-prompt-v1';
export const DIRECTOR_PROMPT_VERSION = 'director-analysis-v3';
export const CAMERA_PROMPT_VERSION = 'shot-selection-rag-v2';
export const STORYBOARD_PROMPT_VERSION = 'storyboard-v2';

export class ProviderError extends Error {
  constructor(code, message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function createTextProvider() {
  const provider = String(process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
  if (provider === 'mock') throw new Error('Please configure a real OpenAI-compatible LLM provider');
  return new OpenAICompatibleProvider({
    provider,
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-chat',
    timeoutMs: Number(process.env.REWRITE_TIMEOUT_MS || 45000),
    structuredTimeoutMs: Number(process.env.STRUCTURED_TIMEOUT_MS || 90000),
    structuredRetries: Number(process.env.STRUCTURED_RETRIES || 3),
  });
}

export class OpenAICompatibleProvider {
  constructor({ provider, baseUrl, apiKey, model, timeoutMs, structuredTimeoutMs, structuredRetries, retryDelayMs = 750 }) {
    this.provider = provider;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.structuredTimeoutMs = Math.max(this.timeoutMs, Number(structuredTimeoutMs || 90000));
    this.structuredRetries = Math.min(5, Math.max(1, Number(structuredRetries || 3)));
    this.retryDelayMs = Math.max(0, Number(retryDelayMs || 0));
  }

  async rewrite({ sourceText, background = '', genre, idempotencyKey }) {
    if (!this.apiKey) {
      throw new ProviderError('SCRIPT_PROVIDER_NOT_CONFIGURED', '文案服务尚未配置，请设置 LLM_API_KEY', { retryable: false });
    }
    const systemPrompt = requiredPrompt('LLM_REWRITE_SYSTEM_PROMPT');
    const userPrompt = renderPrompt(requiredPrompt('LLM_REWRITE_USER_PROMPT_TEMPLATE'), {
      background,
      genre,
      idempotencyKey,
      sourceText,
    });
    const body = {
      model: this.model,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.requestRewrite(body);
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === 2) break;
        await new Promise(resolve => setTimeout(resolve, 350 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async generateShotPrompts({ scriptText, summary, background = '', genre, visualBible, count, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_SHOT_USER_PROMPT_TEMPLATE'), {
      background,
      genre,
      count,
      visualBible: JSON.stringify(visualBible || {}),
      summary: summary || '',
      scriptText,
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_SHOT_SYSTEM_PROMPT'), userPrompt, SHOT_PROMPT_VERSION);
  }

  async generateVisualBible({ segments, background = '', genre, visualStyle, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_VISUAL_BIBLE_USER_PROMPT_TEMPLATE'), {
      background,
      genre,
      visualStyle,
      segments: JSON.stringify(segments),
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_VISUAL_BIBLE_SYSTEM_PROMPT'), userPrompt, 'visual-bible-v1');
  }

  async generateDirectorAnalysis({ segments, background = '', genre, configuration, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_DIRECTOR_USER_PROMPT_TEMPLATE'), {
      background,
      genre,
      configuration: JSON.stringify(configuration || {}),
      segments: JSON.stringify(segments),
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_DIRECTOR_SYSTEM_PROMPT'), userPrompt, DIRECTOR_PROMPT_VERSION);
  }

  async generateShotSelection({ directorAnalysis, retrievalContexts, visualBible, background = '', configuration, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_CAMERA_USER_PROMPT_TEMPLATE'), {
      background,
      directorAnalysis: JSON.stringify(directorAnalysis),
      retrievalContexts: JSON.stringify(retrievalContexts),
      visualBible: JSON.stringify(visualBible || {}),
      configuration: JSON.stringify(configuration || {}),
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_CAMERA_SYSTEM_PROMPT'), userPrompt, CAMERA_PROMPT_VERSION);
  }

  async generateStoryboard({ directorAnalysis, shotSelection, visualBible, background = '', configuration, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_STORYBOARD_USER_PROMPT_TEMPLATE'), {
      background,
      directorAnalysis: JSON.stringify(directorAnalysis),
      shotSelection: JSON.stringify(shotSelection),
      visualBible: JSON.stringify(visualBible || {}),
      configuration: JSON.stringify(configuration || {}),
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_STORYBOARD_SYSTEM_PROMPT'), userPrompt, STORYBOARD_PROMPT_VERSION);
  }

  async requestStructured(system, user, promptVersion) {
    if (!this.apiKey) throw new ProviderError('SCRIPT_PROVIDER_NOT_CONFIGURED', '文案服务尚未配置，请设置 LLM_API_KEY');
    // Some OpenAI-compatible gateways require the literal lowercase word
    // "json" in the messages when response_format is json_object.
    const structuredUser = `${user}\n输出合法 json 对象，不要输出 JSON 之外的内容。`;
    const structuredTemperature = Math.min(1, Math.max(0, Number(process.env.LLM_STRUCTURED_TEMPERATURE ?? 0.2)));
    const body = { model: this.model, temperature: structuredTemperature, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: structuredUser }] };
    let lastError;
    for (let attempt = 0; attempt < this.structuredRetries; attempt += 1) {
      try {
        const payload = await this.requestPayload(body, this.structuredTimeoutMs);
        const content = payload?.choices?.[0]?.message?.content || '{}';
        let parsed;
        try {
          parsed = JSON.parse(cleanGeneratedText(content));
        } catch {
          throw new ProviderError('SCRIPT_PROVIDER_INVALID_RESPONSE', '模型返回的结构化 JSON 无效', { retryable: false });
        }
        return { ...parsed, provider: this.provider, model: this.model, promptVersion };
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === this.structuredRetries - 1) break;
        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async requestRewrite(body) {
    const payload = await this.requestPayload(body);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError('SCRIPT_PROVIDER_INVALID_RESPONSE', '文案服务未返回有效内容', { retryable: false });
    }
    let parsed;
    try {
      parsed = JSON.parse(cleanGeneratedText(content));
    } catch {
      throw new ProviderError('SCRIPT_PROVIDER_INVALID_RESPONSE', '文案服务返回的 JSON 无效', { retryable: false });
    }
    return {
      cleanedText: cleanGeneratedText(parsed.cleanedText || ''),
      segments: parsed.segments,
      rawContent: content,
      provider: this.provider,
      model: this.model,
      usage: payload.usage || null,
    };
  }

  async requestPayload(body, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new ProviderError('SCRIPT_PROVIDER_NETWORK', '文案服务连接失败，请稍后重试', { retryable: true });
      }
      const raw = await response.text();
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        let providerMessage = '';
        try { providerMessage = JSON.parse(raw)?.error?.message || ''; } catch { /* provider may return plain text */ }
        if (providerMessage) this.lastProviderMessage = providerMessage.slice(0, 300);
        throw new ProviderError(
          retryable ? 'SCRIPT_PROVIDER_UNAVAILABLE' : 'SCRIPT_PROVIDER_REQUEST_INVALID',
          retryable ? '文案服务暂时不可用，请稍后重试' : '文案服务拒绝了本次请求',
          { retryable, status: response.status },
        );
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ProviderError('SCRIPT_PROVIDER_INVALID_RESPONSE', '文案服务返回格式无效', { retryable: false });
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function validateRewriteResult(result) {
  if (!result || !Array.isArray(result.segments) || result.segments.length < 1) {
    throw new ProviderError('SCRIPT_PROVIDER_INVALID_RESPONSE', '文案服务返回的分段数量无效', { retryable: false });
  }
  const segments = result.segments.map((segment, index) => {
    const sequence = Number(segment.sequence);
    const scriptText = cleanGeneratedText(segment.scriptText || '');
    const title = cleanGeneratedText(segment.title || `片段 ${index + 1}`).slice(0, 20);
    if (sequence !== index + 1 || !scriptText) {
      throw new ProviderError('SCRIPT_PROVIDER_INVALID_RESPONSE', '文案服务返回的分段内容无效', { retryable: false });
    }
    return {
      sequence,
      title: title || `片段 ${index + 1}`,
      scriptText,
      summary: cleanGeneratedText(segment.summary || '').slice(0, 120),
    };
  });
  return {
    cleanedText: cleanGeneratedText(result.cleanedText || ''),
    segments,
    provider: result.provider || 'unknown',
    model: result.model || 'unknown',
    usage: result.usage || null,
  };
}
