import { ComfyUiMediaProvider } from './comfyui.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createMediaProvider() {
  const provider = String(process.env.MEDIA_PROVIDER || 'mock').toLowerCase();
  if (provider === 'comfyui') {
    return new ComfyUiMediaProvider({
      baseUrl: process.env.COMFYUI_BASE_URL,
      workflowPath: process.env.COMFYUI_WORKFLOW_PATH,
      mediaRoot: process.env.MEDIA_OUTPUT_DIR,
      timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS || 900000),
      pollMs: Number(process.env.COMFYUI_POLL_MS || 1000),
      apiKey: process.env.COMFYUI_API_KEY,
      authToken: process.env.COMFYUI_AUTH_TOKEN,
      basicAuth: process.env.COMFYUI_BASIC_AUTH,
      inputImagePath: process.env.COMFYUI_INPUT_IMAGE_PATH,
      width: Number(process.env.COMFYUI_WIDTH || 576),
      height: Number(process.env.COMFYUI_HEIGHT || 1024),
      frames: Number(process.env.COMFYUI_FRAMES || 121),
      fps: Number(process.env.COMFYUI_FPS || 24),
      fixedSeed: process.env.COMFYUI_FIXED_SEED,
      negativePrompt: process.env.COMFYUI_NEGATIVE_PROMPT,
      ffprobePath: process.env.FFPROBE_PATH,
    });
  }
  if (provider !== 'mock') {
    console.warn(`[media-provider] ${provider} not supported, fallback to mock Provider`);
  }
  return new MockMediaProvider({ stepDelayMs: Number(process.env.MEDIA_MOCK_STEP_MS || 180) });
}

export class MockMediaProvider {
  constructor({ stepDelayMs = 0 } = {}) {
    this.provider = 'mock';
    this.model = 'mock-media-v1';
    this.stepDelayMs = Math.max(0, stepDelayMs);
  }

  async synthesize({ segmentVersion }) {
    await sleep(this.stepDelayMs);
    return {
      objectKey: `mock/audio/${segmentVersion.id}.mp3`,
      durationMs: segmentVersion.duration_ms,
      sizeBytes: Math.max(2048, Math.round(segmentVersion.duration_ms * 4.2)),
      metadata: { voiceId: segmentVersion.voice_id, timedWords: true },
    };
  }

  async createSubtitles({ segmentVersion }) {
    await sleep(this.stepDelayMs);
    return {
      objectKey: `mock/subtitles/${segmentVersion.id}.json`,
      durationMs: segmentVersion.duration_ms,
      sizeBytes: Math.max(256, Array.from(segmentVersion.script_text).length * 5),
      metadata: { style: 'basic-outline', position: 'bottom', text: segmentVersion.script_text },
    };
  }

  async generateVideo({ project, segmentVersion, shot = null }) {
    await sleep(this.stepDelayMs);
    return {
      objectKey: shot ? `mock/video/${segmentVersion.id}/shots/${shot.id}.mp4` : `mock/video/${segmentVersion.id}.mp4`,
      durationMs: shot?.duration_ms || segmentVersion.duration_ms,
      sizeBytes: Math.max(1024 * 256, Math.round((shot?.duration_ms || segmentVersion.duration_ms) * 96)),
      metadata: {
        visualStyle: segmentVersion.visual_style,
        prompt: shot?.prompt_zh || segmentVersion.prompt_text,
        shotId: shot?.id || null,
        characterReferenceKey: `mock/reference/${project.id}/primary-character.png`,
      },
    };
  }

  async matchBgm({ project }) {
    await sleep(this.stepDelayMs);
    return {
      objectKey: `mock/bgm/${project.id}.mp3`,
      durationMs: 0,
      sizeBytes: 1024 * 128,
      metadata: { policy: 'auto', genre: project.genre, ducking: -16 },
    };
  }
}
