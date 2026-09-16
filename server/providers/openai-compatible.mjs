import { cleanGeneratedText } from '../safety.mjs';
import { optionalPrompt, requiredPrompt, renderPrompt } from '../prompt-config.mjs';

export const PROMPT_VERSION = 'rewrite-v1';
export const SHOT_PROMPT_VERSION = 'shot-prompt-v1';
export const DIRECTOR_PROMPT_VERSION = 'director-analysis-v2';
export const CAMERA_PROMPT_VERSION = 'shot-selection-rag-v1';
export const STORYBOARD_PROMPT_VERSION = 'storyboard-v1';

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
  if (provider === 'mock') return new MockTextProvider();
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

  async rewrite({ sourceText, genre, idempotencyKey }) {
    if (!this.apiKey) {
      throw new ProviderError('SCRIPT_PROVIDER_NOT_CONFIGURED', '文案服务尚未配置，请设置 LLM_API_KEY', { retryable: false });
    }
    const systemPrompt = requiredPrompt('LLM_REWRITE_SYSTEM_PROMPT');
    const userPrompt = renderPrompt(requiredPrompt('LLM_REWRITE_USER_PROMPT_TEMPLATE'), {
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

  async generateShotPrompts({ scriptText, summary, genre, visualBible, count, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_SHOT_USER_PROMPT_TEMPLATE'), {
      genre,
      count,
      visualBible: JSON.stringify(visualBible || {}),
      summary: summary || '',
      scriptText,
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_SHOT_SYSTEM_PROMPT'), userPrompt, SHOT_PROMPT_VERSION);
  }

  async generateVisualBible({ segments, genre, visualStyle, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_VISUAL_BIBLE_USER_PROMPT_TEMPLATE'), {
      genre,
      visualStyle,
      segments: JSON.stringify(segments),
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_VISUAL_BIBLE_SYSTEM_PROMPT'), userPrompt, 'visual-bible-v1');
  }

  async generateDirectorAnalysis({ segments, genre, configuration, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_DIRECTOR_USER_PROMPT_TEMPLATE'), {
      genre,
      configuration: JSON.stringify(configuration || {}),
      segments: JSON.stringify(segments),
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_DIRECTOR_SYSTEM_PROMPT'), userPrompt, DIRECTOR_PROMPT_VERSION);
  }

  async generateShotSelection({ directorAnalysis, retrievalContexts, visualBible, configuration, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_CAMERA_USER_PROMPT_TEMPLATE'), {
      directorAnalysis: JSON.stringify(directorAnalysis),
      retrievalContexts: JSON.stringify(retrievalContexts),
      visualBible: JSON.stringify(visualBible || {}),
      configuration: JSON.stringify(configuration || {}),
      idempotencyKey,
    });
    return this.requestStructured(requiredPrompt('LLM_CAMERA_SYSTEM_PROMPT'), userPrompt, CAMERA_PROMPT_VERSION);
  }

  async generateStoryboard({ directorAnalysis, shotSelection, visualBible, configuration, idempotencyKey }) {
    const userPrompt = renderPrompt(requiredPrompt('LLM_STORYBOARD_USER_PROMPT_TEMPLATE'), {
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

export class MockTextProvider {
  constructor() {
    this.provider = 'mock';
    this.model = 'mock-rewrite-v1';
  }

  async rewrite({ sourceText }) {
    const paragraphs = sourceText.split(/\n{2,}/).map(item => item.trim()).filter(Boolean);
    // Mock provider 应完整保留输入段落，不人为截断分段数量。
    const pieces = paragraphs.length ? paragraphs : [sourceText];
    const segments = pieces.map((text, index) => ({
      sequence: index + 1,
      title: `故事片段 ${index + 1}`,
      scriptText: text.length > 180 ? `${text.slice(0, 178)}…` : text,
      summary: text.slice(0, 45),
    }));
    return {
      cleanedText: sourceText.trim(),
      segments,
      provider: this.provider,
      model: this.model,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  async generateShotPrompts({ count = 1, scriptText, summary }) {
    const template = optionalPrompt('MOCK_SHOT_PROMPT_TEMPLATE');
    return { shots: Array.from({ length: count }, (_, index) => ({
      sequence: index + 1,
      promptZh: renderPrompt(template, { sequence: index + 1, description: summary || scriptText.slice(0, 40) }) || String(summary || scriptText.slice(0, 40)),
    })), provider: this.provider, model: this.model, promptVersion: SHOT_PROMPT_VERSION };
  }

  async generateVisualBible({ segments, genre, visualStyle }) {
    return { characters: [], scenes: segments.map((item, index) => ({ name: item.title || `场景${index + 1}`, description: item.summary || item.scriptText.slice(0, 60) })), style: `${genre}，${visualStyle}，人物与服装跨镜头保持一致` };
  }

  async generateDirectorAnalysis({ segments }) {
    return {
      segments: segments.map(segment => {
        const count = Math.max(1, Number(segment.targetShotCount || 1));
        return {
          segmentId: segment.id,
          beats: Array.from({ length: count }, (_, index) => ({
            beatId: `${segment.id}-beat-${index + 1}`,
            plot: `${segment.summary || segment.scriptText.slice(0, 80)}（节拍 ${index + 1}）`,
            emotion: inferEmotion(segment.scriptText),
            emotionIntensity: Math.min(1, 0.55 + index * 0.05),
            action: inferAction(segment.scriptText),
            actionSpeed: /跑|追|冲|逃/.test(segment.scriptText) ? '快' : '慢',
            sceneType: inferScene(segment.scriptText),
            narrativePurpose: index === count - 1 ? '突出关键信息并推动下一节拍' : '推进剧情并积累情绪',
            subjectCount: 1,
            continuityConstraints: [],
          })),
        };
      }),
      provider: this.provider,
      model: this.model,
      promptVersion: DIRECTOR_PROMPT_VERSION,
    };
  }

  async generateShotSelection({ directorAnalysis, retrievalContexts }) {
    return {
      segments: directorAnalysis.segments.map(segment => ({
        segmentId: segment.segmentId,
        selections: segment.beats.map((beat, index) => {
          const evidence = retrievalContexts.find(item => item.beatId === beat.beatId)?.evidence || [];
          return {
            beatId: beat.beatId,
            shotSize: /线索|发现|信息/.test(beat.narrativePurpose) ? '特写' : '中景',
            angle: /恐惧|无助|压迫/.test(beat.emotion) ? '轻微俯拍' : '平视',
            movement: beat.actionSpeed === '快' ? '稳定跟拍' : '缓慢推进',
            focalLengthMm: /特写/.test(beat.narrativePurpose) ? 50 : 35,
            composition: /恐惧|不安/.test(beat.emotion) ? '负空间' : '三分法',
            durationMs: 5000,
            selectionReason: '根据情绪强度、叙事目的和知识库约束选择单一明确的镜头语言',
            evidenceIds: evidence.slice(0, 3).map(item => item.id),
            transitionToNext: index === segment.beats.length - 1 ? null : { type: 'cut', durationMs: 0, motivation: '保持叙事连续' },
          };
        }),
      })),
      provider: this.provider,
      model: this.model,
      promptVersion: CAMERA_PROMPT_VERSION,
    };
  }

  async generateStoryboard({ directorAnalysis, shotSelection }) {
    return {
      segments: shotSelection.segments.map(segment => {
        const directorSegment = directorAnalysis.segments.find(item => item.segmentId === segment.segmentId);
        return {
          segmentId: segment.segmentId,
          shots: segment.selections.map((selection, index) => {
            const beat = directorSegment?.beats.find(item => item.beatId === selection.beatId) || {};
            return {
              sequence: index + 1,
              beatId: selection.beatId,
              plot: beat.plot || '',
              shotSize: selection.shotSize,
              movement: selection.movement,
              angle: selection.angle,
              focalLengthMm: selection.focalLengthMm,
              composition: selection.composition,
              purpose: beat.narrativePurpose || '',
              durationMs: selection.durationMs,
              selectionReason: selection.selectionReason,
              evidenceIds: selection.evidenceIds,
              transitionToNext: selection.transitionToNext,
            };
          }),
        };
      }),
      provider: this.provider,
      model: this.model,
      promptVersion: STORYBOARD_PROMPT_VERSION,
    };
  }
}

function inferEmotion(text) {
  if (/怕|恐|惊|诡|血|死/.test(text)) return '恐惧';
  if (/怒|恨|吼/.test(text)) return '愤怒';
  if (/哭|泪|悲|失去/.test(text)) return '悲伤';
  return '不安';
}

function inferAction(text) {
  const match = String(text || '').match(/[^。！？]*(?:发现|拿起|看见|走|跑|追|转身|打开|进入)[^。！？]*/);
  return match?.[0]?.slice(0, 60) || '人物观察环境并作出反应';
}

function inferScene(text) {
  if (/地铁|隧道|站台/.test(text)) return '隧道';
  if (/房|门|室内/.test(text)) return '室内';
  if (/街|路/.test(text)) return '街道';
  return '新场景';
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
