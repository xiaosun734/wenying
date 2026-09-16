import { ComfyUiMediaProvider } from './comfyui.mjs';

export function createMediaProvider() {
  const provider = String(process.env.MEDIA_PROVIDER || 'comfyui').toLowerCase();
  if (provider !== 'comfyui') {
    throw new Error(`MEDIA_PROVIDER 必须配置为 comfyui，当前值为 ${provider}`);
  }
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
