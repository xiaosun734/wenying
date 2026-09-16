import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComfyUiMediaProvider, compileNegativePrompt, wanFrameCount } from '../server/providers/comfyui.mjs';

test('ComfyUI provider submits workflow and downloads the generated video', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-comfyui-'));
  const workflowPath = join(root, 'workflow.json');
  const mediaRoot = join(root, 'media');
  await writeFile(workflowPath, JSON.stringify({
    '6': { class_type: 'CLIPTextEncode', _meta: { title: 'Positive Prompt' }, inputs: { text: 'old positive' } },
    '7': { class_type: 'CLIPTextEncode', _meta: { title: 'Negative Prompt' }, inputs: { text: 'old negative' } },
    '3': { class_type: 'KSampler', inputs: { seed: 1 } },
    '55': { class_type: 'Wan22ImageToVideoLatent', inputs: { width: 480, height: 832, length: 81 } },
    '57': { class_type: 'CreateVideo', inputs: { fps: 12 } },
    '58': { class_type: 'SaveVideo', inputs: { filename_prefix: 'old' } },
  }));

  let submittedPrompt;
  let historyRequests = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/prompt') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submittedPrompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: 'prompt-1' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/history/prompt-1') {
      historyRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(historyRequests < 2 ? {} : {
        'prompt-1': { outputs: { '58': { videos: [{ filename: 'wenying.mp4', subfolder: 'video', type: 'output' }] } } },
      }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.from('fake-mp4'));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const provider = new ComfyUiMediaProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      workflowPath,
      mediaRoot,
      pollMs: 1,
      timeoutMs: 10_000,
      fixedSeed: 42,
      width: 576,
      height: 1024,
      frames: 121,
      fps: 24,
      negativePrompt: 'blurry, low quality, flicker, watermark, text, distorted anatomy, duplicate limbs',
    });
    const result = await provider.generateVideo({
      project: { id: 'project-1', genre: 'fantasy' },
      segmentVersion: {
        id: 'version-1',
        segment_id: 'segment-1',
        script_text: 'A hero walks through the rain.',
        prompt_text: 'cinematic hero walking through rain',
        duration_ms: 5000,
      },
      shot: {
        id: 'shot-1',
        prompt_zh: '黑发青年穿过雨夜街道，镜头缓慢推进',
        prompt_en: 'This legacy English prompt must not be used.',
        duration_ms: 5000,
        generation_spec: {
          motionPrompt: '沈砚缓慢转头看向隧道，电子屏持续闪烁',
          mustNotShow: ['列车实体', '女人实体'],
          protectedPositiveConcepts: ['闪烁'],
        },
      },
    });

    assert.equal(submittedPrompt['6'].inputs.text, '沈砚缓慢转头看向隧道，电子屏持续闪烁');
    assert.match(submittedPrompt['7'].inputs.text, /blurry/);
    assert.doesNotMatch(submittedPrompt['7'].inputs.text, /flicker/);
    assert.match(submittedPrompt['7'].inputs.text, /不要出现列车实体/);
    assert.equal(submittedPrompt['3'].inputs.seed, 42);
    assert.equal(submittedPrompt['55'].inputs.length, 121);
    assert.equal(submittedPrompt['57'].inputs.fps, 24);
    assert.equal(historyRequests, 2);
    assert.equal(result.objectKey, 'projects/project-1/segments/segment-1/versions/version-1/shots/shot-1/video.mp4');
    assert.equal(result.sizeBytes, 8);
    assert.equal(result.metadata.seed, 42);
    assert.equal(result.metadata.frames, 121);
    assert.match(result.metadata.workflowHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(join(mediaRoot, result.objectKey)), Buffer.from('fake-mp4'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('calculates legal Wan frame counts from each shot duration', () => {
  assert.equal(wanFrameCount(3000, 24), 73);
  assert.equal(wanFrameCount(5000, 24), 121);
  assert.equal(wanFrameCount(5600, 24), 133);
});

test('keeps protected positive concepts out of the negative prompt', () => {
  const negative = compileNegativePrompt('低质量，闪烁，人物变形', ['列车实体'], ['闪烁']);
  assert.doesNotMatch(negative, /闪烁/);
  assert.match(negative, /低质量/);
  assert.match(negative, /不要出现列车实体/);
});
