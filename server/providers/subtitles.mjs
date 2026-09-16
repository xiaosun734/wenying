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
    const payload = {
      version: 1,
      durationMs: Number(segmentVersion.duration_ms || 0),
      text: segmentVersion.script_text || '',
      cues: [],
    };
    const data = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    await writeFile(output, data);
    return {
      objectKey,
      durationMs: payload.durationMs,
      sizeBytes: data.length,
      metadata: { format: 'json', cueCount: 0, textLength: Array.from(payload.text).length },
    };
  }
}

export function createSubtitleProvider({ mediaRoot } = {}) {
  return new JsonSubtitleProvider({ mediaRoot });
}

function safe(value) { return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_'); }
