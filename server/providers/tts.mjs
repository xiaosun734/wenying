import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { probeMedia } from '../media-probe.mjs';

export class DoubaoTtsProvider {
  constructor({ baseUrl, appId, accessToken, resourceId, mediaRoot, ffprobePath }) {
    this.provider = 'doubao'; this.model = 'doubao-tts-v3'; this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.appId = appId; this.accessToken = accessToken; this.resourceId = resourceId; this.mediaRoot = resolve(mediaRoot || './data/media');
    this.ffprobePath = ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  }
  async synthesize({ project, segmentVersion }) {
    if (!this.baseUrl || !this.appId || !this.accessToken) throw Object.assign(new Error('豆包 TTS 尚未配置'), { code: 'TTS_NOT_CONFIGURED' });
    const response = await fetch(this.baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer;${this.accessToken}`, 'X-Api-App-Id': this.appId, ...(this.resourceId ? { 'X-Api-Resource-Id': this.resourceId } : {}) }, body: JSON.stringify({ app: { appid: this.appId, token: this.accessToken, cluster: process.env.DOUBAO_TTS_CLUSTER || 'volcano_tts' }, user: { uid: project.id }, audio: { voice_type: process.env.DOUBAO_TTS_VOICE || segmentVersion.voice_id, encoding: 'mp3' }, request: { reqid: segmentVersion.id, text: segmentVersion.script_text, operation: 'query' } }) });
    if (!response.ok) throw Object.assign(new Error(`豆包 TTS 请求失败（HTTP ${response.status}）`), { code: 'TTS_PROVIDER_FAILED' });
    const payload = await response.json();
    const audioBase64 = payload?.data || payload?.audio || payload?.data?.audio;
    if (!audioBase64) throw Object.assign(new Error('豆包 TTS 未返回音频'), { code: 'TTS_INVALID_RESPONSE' });
    const objectKey = `projects/${safe(project.id)}/segments/${safe(segmentVersion.segment_id)}/versions/${safe(segmentVersion.id)}/audio.mp3`;
    const output = resolve(this.mediaRoot, objectKey);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(audioBase64, 'base64'));
    const probe = await probeMedia(output, { ffprobePath: this.ffprobePath, optional: true });
    const durationMs = probe?.durationMs || Number(payload.duration_ms || segmentVersion.duration_ms);
    return {
      objectKey,
      durationMs,
      sizeBytes: probe?.sizeBytes || Buffer.byteLength(audioBase64, 'base64'),
      metadata: {
        voiceId: segmentVersion.voice_id,
        provider: 'doubao',
        durationSource: probe?.durationMs ? 'ffprobe' : (payload.duration_ms ? 'provider' : 'estimated'),
        probe,
      },
    };
  }
}

export function createTtsProvider({ mediaRoot } = {}) {
  if (String(process.env.TTS_PROVIDER || '').toLowerCase() === 'doubao') {
    return new DoubaoTtsProvider({ baseUrl: process.env.DOUBAO_TTS_URL || 'https://openspeech.bytedance.com/api/v1/tts', appId: process.env.DOUBAO_TTS_APP_ID, accessToken: process.env.DOUBAO_TTS_ACCESS_TOKEN, resourceId: process.env.DOUBAO_TTS_RESOURCE_ID, mediaRoot, ffprobePath: process.env.FFPROBE_PATH });
  }
  return null;
}

function safe(value) { return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_'); }
