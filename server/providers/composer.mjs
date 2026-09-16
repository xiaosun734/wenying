import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { probeMedia } from '../media-probe.mjs';

export class MockComposer {
  constructor() { this.provider = 'mock'; this.model = 'mock-concat-v1'; }
  async composeSegment({ project, segmentVersion, shots, transitions = [], audioAsset }) {
    return {
      objectKey: `mock/video/${segmentVersion.id}.mp4`,
      durationMs: audioAsset?.durationMs || segmentVersion.duration_ms,
      sizeBytes: Math.max(1024 * 512, segmentVersion.duration_ms * 128),
      metadata: { shotCount: shots.length, transitions: transitionSummary(shots, transitions), audio: Boolean(audioAsset?.objectKey) },
    };
  }
}

export class FfmpegComposer {
  constructor({ mediaRoot = './data/media', ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', fps = 24 } = {}) {
    this.provider = 'ffmpeg';
    this.model = 'ffmpeg-timeline-v2';
    this.mediaRoot = resolve(mediaRoot);
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.fps = Math.max(1, Number(fps) || 24);
  }

  async composeSegment({ project, segmentVersion, shots, transitions = [], audioAsset }) {
    if (!shots.length) throw Object.assign(new Error('没有可合成的镜头素材'), { code: 'COMPOSER_SHOTS_EMPTY' });
    const objectKey = `projects/${safe(project.id)}/segments/${safe(segmentVersion.segment_id)}/versions/${safe(segmentVersion.id)}/video.mp4`;
    const output = resolve(this.mediaRoot, objectKey);
    await mkdir(dirname(output), { recursive: true });
    const segmentTransitions = transitionsForShots(shots, transitions);
    await this.composeTimeline({ output, shots, transitions: segmentTransitions, audioAsset });
    const probe = await probeMedia(output, { ffprobePath: this.ffprobePath });
    if (!probe.hasVideo) throw Object.assign(new Error('合成结果缺少视频流'), { code: 'COMPOSER_VIDEO_STREAM_MISSING' });
    if (audioAsset?.objectKey && !probe.hasAudio) throw Object.assign(new Error('合成结果缺少音轨'), { code: 'COMPOSER_AUDIO_STREAM_MISSING' });
    const targetDurationMs = audioAsset?.durationMs || shots.reduce((sum, shot) => sum + Number(shot.duration_ms || 0), 0);
    return {
      objectKey,
      durationMs: probe.durationMs || targetDurationMs,
      sizeBytes: probe.sizeBytes,
      metadata: {
        shotCount: shots.length,
        transitions: transitionSummary(shots, transitions),
        audio: probe.hasAudio,
        requestedDurationMs: targetDurationMs,
        actualDurationMs: probe.durationMs,
        probe,
      },
    };
  }

  async composeTimeline({ output, shots, transitions, audioAsset }) {
    const args = ['-y'];
    shots.forEach(shot => args.push('-i', resolve(this.mediaRoot, shot.objectKey)));
    const audioKey = audioAsset?.objectKey || audioAsset?.object_key;
    if (audioKey) args.push('-i', resolve(this.mediaRoot, audioKey));

    const filters = [];
    for (let index = 0; index < shots.length; index += 1) {
      const incoming = index > 0 ? renderedTransitionSeconds(transitions[index - 1]) : 0;
      const visibleSeconds = Math.max(0.04, Number(shots[index].duration_ms || 0) / 1000);
      const materialSeconds = visibleSeconds + incoming;
      filters.push(
        `[${index}:v]tpad=stop_mode=clone:stop_duration=${materialSeconds.toFixed(3)},` +
        `trim=duration=${materialSeconds.toFixed(3)},setpts=PTS-STARTPTS,settb=AVTB,fps=${this.fps},format=yuv420p[v${index}]`,
      );
    }

    let previous = 'v0';
    let timelineSeconds = Math.max(0.04, Number(shots[0].duration_ms || 0) / 1000);
    for (let index = 1; index < shots.length; index += 1) {
      const transition = transitions[index - 1] || { type: 'cut', duration_ms: 0 };
      const transitionSeconds = renderedTransitionSeconds(transition);
      const outputLabel = `mix${index}`;
      if (transitionSeconds > 0) {
        const name = transition.type === 'fade' ? 'fadeblack' : 'fade';
        const offset = Math.max(0, timelineSeconds - transitionSeconds);
        filters.push(`[${previous}][v${index}]xfade=transition=${name}:duration=${transitionSeconds.toFixed(3)}:offset=${offset.toFixed(3)}[${outputLabel}]`);
      } else {
        filters.push(`[${previous}][v${index}]concat=n=2:v=1:a=0[${outputLabel}]`);
      }
      timelineSeconds += Math.max(0.04, Number(shots[index].duration_ms || 0) / 1000);
      previous = outputLabel;
    }

    args.push('-filter_complex', filters.join(';'), '-map', `[${previous}]`);
    if (audioKey) args.push('-map', `${shots.length}:a:0`, '-c:a', 'aac', '-shortest');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(this.fps), '-movflags', '+faststart', output);
    await run(this.ffmpegPath, args);
  }
}

export function createComposerProvider({ mediaRoot } = {}) {
  return String(process.env.COMPOSER_PROVIDER || 'mock').toLowerCase() === 'ffmpeg'
    ? new FfmpegComposer({
      mediaRoot,
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
      ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
      fps: Number(process.env.COMFYUI_FPS || 24),
    })
    : new MockComposer();
}

function safe(value) { return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function transitionsForShots(shots, transitions) {
  return shots.slice(0, -1).map((shot, index) => transitions.find(item => item.from_shot_id === shot.id && item.to_shot_id === shots[index + 1].id) || { type: 'cut', duration_ms: 0 });
}
function renderedTransitionSeconds(transition) {
  return ['dissolve', 'fade'].includes(transition?.type) ? Math.max(0, Number(transition.duration_ms || 0) / 1000) : 0;
}
function transitionSummary(shots, transitions) {
  return transitionsForShots(shots, transitions).map(item => ({ type: item.type, durationMs: item.duration_ms || 0 }));
}
function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(Object.assign(new Error(`FFmpeg 启动失败: ${error.message}`), { code: 'FFMPEG_NOT_FOUND' })));
    child.on('close', code => code === 0 ? resolvePromise() : reject(Object.assign(new Error(`FFmpeg 合成失败: ${stderr.slice(-1200)}`), { code: 'FFMPEG_COMPOSE_FAILED' })));
  });
}
