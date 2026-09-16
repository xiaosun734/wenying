import { spawn } from 'node:child_process';

export async function probeMedia(path, { ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', optional = false } = {}) {
  try {
    const output = await run(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,nb_frames,sample_rate,channels',
      '-of', 'json',
      path,
    ]);
    const payload = JSON.parse(output || '{}');
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const video = streams.find(stream => stream.codec_type === 'video') || null;
    const audio = streams.find(stream => stream.codec_type === 'audio') || null;
    const durationMs = Math.max(0, Math.round(Number(payload.format?.duration || 0) * 1000));
    const fps = parseRate(video?.avg_frame_rate);
    const frameCount = positiveInteger(video?.nb_frames) || (durationMs && fps ? Math.round(durationMs * fps / 1000) : 0);
    return {
      durationMs,
      sizeBytes: Math.max(0, Number(payload.format?.size || 0)),
      width: positiveInteger(video?.width),
      height: positiveInteger(video?.height),
      fps,
      frameCount,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      videoCodec: video?.codec_name || null,
      audioCodec: audio?.codec_name || null,
      sampleRate: positiveInteger(audio?.sample_rate),
      channels: positiveInteger(audio?.channels),
      streams,
    };
  } catch (error) {
    if (optional) return null;
    throw Object.assign(new Error(`媒体探测失败: ${error.message}`), { code: 'MEDIA_PROBE_FAILED', cause: error });
  }
}

function parseRate(value) {
  const text = String(value || '');
  if (!text) return 0;
  const [left, right] = text.split('/').map(Number);
  const rate = right ? left / right : left;
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function positiveInteger(value) {
  const parsed = Math.round(Number(value || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(error));
    child.on('close', code => code === 0
      ? resolve(stdout)
      : reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`)));
  });
}
