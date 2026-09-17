import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class JsonSubtitleProvider {
  constructor({ mediaRoot = './data/media' } = {}) {
    this.provider = 'local';
    this.model = 'json-subtitles-v1';
    this.mediaRoot = resolve(mediaRoot);
  }

  async createSubtitles({ project, segmentVersion }) {
    const objectKey = `projects/${safe(project.id)}/segments/${safe(segmentVersion.segment_id)}/versions/${safe(segmentVersion.id)}/subtitles.json`;
    const output = resolve(this.mediaRoot, objectKey);
    await mkdir(dirname(output), { recursive: true });
    const durationMs = Number(segmentVersion.duration_ms || 0);
    const cues = buildCues(segmentVersion.script_text || '', durationMs);
    const payload = { version: 2, durationMs, text: segmentVersion.script_text || '', cues };
    const data = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    await writeFile(output, data);
    const srt = cues.map((cue, index) => `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}\n`).join('\n');
    await writeFile(output.replace(/\.json$/i, '.srt'), Buffer.from(srt, 'utf8'));
    return {
      objectKey,
      durationMs,
      sizeBytes: data.length,
      metadata: { format: 'json+srt', cueCount: cues.length, textLength: Array.from(payload.text).length, srtObjectKey: objectKey.replace(/\.json$/i, '.srt') },
    };
  }
}
export function createSubtitleProvider({ mediaRoot } = {}) {
  return new JsonSubtitleProvider({ mediaRoot });
}

function safe(value) { return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function buildCues(text, durationMs) {
  const pieces = String(text || '')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map(value => value.trim())
    .filter(Boolean)
    .flatMap(value => Array.from(value).length > 30 ? chunkText(value, 26) : [value]);
  if (!pieces.length) return [];
  const weights = pieces.map(value => Math.max(1, Array.from(value).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return pieces.map((piece, index) => {
    const remaining = Math.max(0, durationMs - cursor);
    const duration = index === pieces.length - 1 ? remaining : Math.max(500, Math.round(durationMs * weights[index] / totalWeight));
    const cue = { startMs: cursor, endMs: Math.min(durationMs, cursor + duration), text: piece };
    cursor = cue.endMs;
    return cue;
  }).filter(cue => cue.endMs > cue.startMs);
}

function chunkText(value, size) {
  const chars = Array.from(value);
  const chunks = [];
  for (let index = 0; index < chars.length; index += size) chunks.push(chars.slice(index, index + size).join(''));
  return chunks;
}

function formatSrtTime(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor(value % 3600000 / 60000);
  const seconds = Math.floor(value % 60000 / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}