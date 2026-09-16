import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildGenerationSpec } from '../server/storyboard-task.mjs';
import {
  closeDatabase,
  createMediaAsset,
  createProject,
  createScriptVersion,
  createSegment,
  createSegmentShot,
  createSegmentVersion,
  openDatabase,
} from '../server/db.mjs';
import { distributeShotDurations } from '../server/media-task.mjs';
import { FfmpegComposer } from '../server/providers/composer.mjs';
import { probeMedia } from '../server/media-probe.mjs';

const execFileAsync = promisify(execFile);

test('builds an executable generation spec without leaking abstract narrative purpose', () => {
  const shot = {
    plot: '远处突然传来列车进站的轰鸣。',
    shotSize: '近景', angle: '平视', composition: '人物在右，隧道在左',
    focalLengthMm: 75, movement: '固定镜头', purpose: '推动未知威胁接近',
  };
  const beat = {
    action: '沈砚听见轰鸣后意识到列车正在接近。',
    continuityConstraints: ['列车仅以远处轰鸣体现', '不得确认列车外观或是否真正进站', '女人只通过广播声音出现'],
  };
  const bible = {
    characters: [{ name: '沈砚', appearance: '短黑发，清瘦脸型', costume: '黑色西装和白衬衫' }],
    scenes: [{ name: '废弃地铁站', description: '冷灰暗蓝灯光，幽暗隧道在左侧' }],
    style: '日系二维动画电影风格',
  };
  const spec = buildGenerationSpec(shot, beat, bible, { visualStyle: 'anime' });
  assert.equal(spec.version, 'generation-spec-v1');
  assert.ok(spec.mustShow.includes('沈砚'));
  assert.ok(spec.mustNotShow.includes('列车实体'));
  assert.ok(spec.mustNotShow.includes('女人实体'));
  assert.ok(spec.audioOnlyEvents.length >= 1);
  assert.match(spec.motionPrompt, /短黑发/);
  assert.doesNotMatch(spec.motionPrompt, /列车/);
  assert.doesNotMatch(spec.motionPrompt, /叙事目的/);
});

test('redistributes shot durations to the measured audio duration exactly', () => {
  const durations = distributeShotDurations(29088, [
    { duration_ms: 4699 }, { duration_ms: 4599 }, { duration_ms: 5199 },
    { duration_ms: 4999 }, { duration_ms: 3000 }, { duration_ms: 4999 }, { duration_ms: 5600 },
  ]);
  assert.equal(durations.length, 7);
  assert.equal(durations.reduce((sum, value) => sum + value, 0), 29088);
  assert.ok(durations.every(value => value > 0));
});

test('FFmpeg composer trims shots, maps audio, and reports measured output', async t => {
  try {
    await execFileAsync('ffmpeg', ['-version'], { windowsHide: true });
    await execFileAsync('ffprobe', ['-version'], { windowsHide: true });
  } catch {
    t.skip('ffmpeg/ffprobe not available');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'wenying-composer-'));
  const mediaRoot = join(root, 'media');
  await mkdir(join(mediaRoot, 'inputs'), { recursive: true });
  try {
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(mediaRoot, 'inputs', 'one.mp4')], { windowsHide: true });
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(mediaRoot, 'inputs', 'two.mp4')], { windowsHide: true });
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'libmp3lame', '-y', join(mediaRoot, 'inputs', 'audio.mp3')], { windowsHide: true });

    const composer = new FfmpegComposer({ mediaRoot, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', fps: 24 });
    const result = await composer.composeSegment({
      project: { id: 'project-1' },
      segmentVersion: { id: 'version-1', segment_id: 'segment-1', duration_ms: 1500 },
      shots: [
        { id: 'shot-1', objectKey: 'inputs/one.mp4', duration_ms: 700 },
        { id: 'shot-2', objectKey: 'inputs/two.mp4', duration_ms: 800 },
      ],
      transitions: [{ from_shot_id: 'shot-1', to_shot_id: 'shot-2', type: 'dissolve', duration_ms: 200 }],
      audioAsset: { objectKey: 'inputs/audio.mp3', durationMs: 1500 },
    });
    const probe = await probeMedia(join(mediaRoot, result.objectKey));
    assert.equal(probe.hasVideo, true);
    assert.equal(probe.hasAudio, true);
    assert.ok(Math.abs(probe.durationMs - 1500) <= 100, `duration was ${probe.durationMs}ms`);
    assert.equal(result.metadata.audio, true);
    assert.equal(result.metadata.transitions[0].type, 'dissolve');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('appends one traceable JSONL record for each created media asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-metadata-log-'));
  const logPath = join(root, 'generation-metadata.jsonl');
  const db = await openDatabase(':memory:', { metadataLogPath: logPath });
  try {
    createProject(db, { id: 'project-1', title: 'Test', genre: 'mystery', sourceText: null });
    createScriptVersion(db, {
      id: 'script-version-1', projectId: 'project-1', source: 'test', immutable: false,
      promptVersion: 'test', provider: 'test', model: 'test', cleanedText: 'test',
    });
    createSegment(db, {
      id: 'segment-1', projectId: 'project-1', scriptVersionId: 'script-version-1',
      sequence: 1, title: 'Test segment', scriptText: 'test', summary: '', durationMs: 1000,
    });
    createSegmentVersion(db, {
      id: 'segment-version-1', segmentId: 'segment-1', source: 'test', scriptText: 'test',
      voiceId: 'steady', visualStyle: 'cinematic', durationMs: 1000,
    });
    createSegmentShot(db, {
      id: 'shot-1', segmentVersionId: 'segment-version-1', sequence: 1,
      promptZh: 'single male subject', generationSpec: { mustNotShow: ['woman entity'] },
    });
    createMediaAsset(db, {
      id: 'asset-1', projectId: 'project-1', segmentVersionId: 'segment-version-1', shotId: 'shot-1',
      type: 'shot_video', provider: 'comfyui', model: 'test-model', objectKey: 'projects/project-1/shot.mp4',
      durationMs: 1000, sizeBytes: 1234,
      metadata: { promptId: 'prompt-1', seed: 123, negativePrompt: 'no woman entity' },
    });

    const records = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].asset.id, 'asset-1');
    assert.equal(records[0].asset.type, 'shot_video');
    assert.equal(records[0].metadata.promptId, 'prompt-1');
    assert.equal(records[0].metadata.seed, 123);
    assert.deepEqual(records[0].shot.generationSpec.mustNotShow, ['woman entity']);
  } finally {
    closeDatabase(db);
    await rm(root, { recursive: true, force: true });
  }
});
