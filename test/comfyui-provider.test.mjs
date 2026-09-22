import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolve } from 'node:path';
import { ComfyUiMediaProvider, compileNegativePrompt, wanFrameCount } from '../server/providers/comfyui.mjs';
import { applyWorkflowManifest, inferWorkflowMode, loadWorkflowManifest, validateWorkflowForManifest, verifyWorkflowPair } from '../server/workflow-manifest.mjs';

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

test('infers the workflow mode from node classes', async () => {
  const t2i = JSON.parse(await readFile(resolve('workflows/z-image-turbo-t2i-api.json'), 'utf8'));
  const i2i = JSON.parse(await readFile(resolve('workflows/krea2-keyframe-img2img-api.json'), 'utf8'));
  const i2v = JSON.parse(await readFile(resolve('workflows/video_wan2_2_5b_i2v_api.json'), 'utf8'));
  assert.equal(inferWorkflowMode(t2i).mode, 't2i');
  assert.equal(inferWorkflowMode(i2i).mode, 'i2i');
  assert.equal(inferWorkflowMode(i2v).mode, 'i2v');
});

test('rejects a manifest paired with the wrong workflow shape', async () => {
  const t2i = JSON.parse(await readFile(resolve('workflows/z-image-turbo-t2i-api.json'), 'utf8'));
  const i2v = JSON.parse(await readFile(resolve('workflows/video_wan2_2_5b_i2v_api.json'), 'utf8'));
  // 运行时 loadWorkflow 会先把 Save (API Format) 的外层 prompt 解开，这里保持同样形态。
  const t2iNodes = t2i.prompt || t2i;
  const i2vNodes = i2v.prompt || i2v;
  const i2vManifest = await loadWorkflowManifest(resolve('workflows/manifests/wan22-5b-i2v.json'));
  const i2iManifest = await loadWorkflowManifest(resolve('workflows/manifests/krea2-keyframe-img2img.json'));
  assert.throws(
    () => validateWorkflowForManifest(t2iNodes, i2vManifest),
    error => error.code === 'WORKFLOW_MANIFEST_MODE_MISMATCH',
  );
  assert.throws(
    () => validateWorkflowForManifest(i2vNodes, i2iManifest),
    error => error.code === 'WORKFLOW_MANIFEST_MODE_MISMATCH',
  );
  // 配对正确时不应抛错。
  assert.doesNotThrow(() => validateWorkflowForManifest(i2vNodes, i2vManifest));
  // 配对正确但工作流被改动、节点编号漂移时，逐字段校验兜底。
  const drifted = structuredClone(i2vManifest);
  drifted.seedInputs = [{ node: '999999', field: 'seed' }];
  assert.throws(
    () => validateWorkflowForManifest(i2vNodes, drifted),
    error => error.code === 'WORKFLOW_MANIFEST_NODE_MISSING',
  );
});

test('keeps the checked-in workflow and manifest pairs consistent', async () => {
  const pairs = [
    ['workflows/video_wan2_2_5b_i2v_api.json', 'workflows/manifests/wan22-5b-i2v.json'],
    ['workflows/z-image-turbo-t2i-api.json', 'workflows/manifests/z-image-turbo-t2i.json'],
    ['workflows/krea2-keyframe-img2img-api.json', 'workflows/manifests/krea2-keyframe-img2img.json'],
    ['workflows/qwen-image-edit-keyframe-api.json', 'workflows/manifests/qwen-image-edit-keyframe.json'],
  ];
  for (const [workflowPath, manifestPath] of pairs) {
    const result = await verifyWorkflowPair(resolve(workflowPath), resolve(manifestPath));
    assert.equal(result.mode, result.declaredMode, workflowPath + ' should match its manifest');
    assert.ok(result.profileId, workflowPath + ' should declare a profileId');
  }
});

test('applies the configured keyframe denoise through the img2img manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-comfyui-keyframe-'));
  const workflowPath = join(root, 'workflow.json');
  const manifestPath = join(root, 'manifest.json');
  const referencePath = join(root, 'reference.png');
  const mediaRoot = join(root, 'media');
  // 1x1 透明 PNG，仅用于验证参考图会被真正读取并上传。
  await writeFile(referencePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7x0AAAAASUVORK5CYII=',
    'base64',
  ));
  await writeFile(workflowPath, JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { seed: 1, denoise: 0.1, positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'old', images: ['8', 0] } },
    '10': { class_type: 'LoadImage', inputs: { image: '' } },
    '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0] } },
  }));
  await writeFile(manifestPath, JSON.stringify({
    profileId: 'test-keyframe-i2i', mode: 'i2i',
    positivePrompt: { node: '6', field: 'text' }, negativePrompt: { node: '7', field: 'text' },
    startImage: { node: '10', field: 'image' }, denoise: { node: '3', field: 'denoise' },
    seedInputs: [{ node: '3', field: 'seed' }], filenamePrefix: { node: '9', field: 'filename_prefix' },
    outputNode: '9', requiresStartImage: true,
  }));
  let submittedPrompt;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/upload/image') {
      for await (const chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'reference.png', subfolder: '', type: 'input' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/prompt') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submittedPrompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: 'keyframe-1' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/history/keyframe-1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ 'keyframe-1': { outputs: { '9': { images: [{ filename: 'keyframe.png', subfolder: '', type: 'output' }] } } } }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('fake-keyframe'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const provider = new ComfyUiMediaProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      workflowPath, imageWorkflowPath: workflowPath, imageWorkflowManifestPath: manifestPath,
      keyframeWorkflowPath: workflowPath, keyframeWorkflowManifestPath: manifestPath,
      keyframeDenoise: 0.73, useReferenceForKeyframes: true,
      mediaRoot, pollMs: 1, timeoutMs: 10_000, negativePrompt: 'blurry',
    });
    const result = await provider.generateImage({
      project: { id: 'project-1' }, prompt: '沈砚站在雨夜站台', seed: 99,
      filenamePrefix: 'keyframe', referenceImagePath: referencePath,
    });
    assert.equal(submittedPrompt['10'].inputs.image, 'reference.png');
    assert.equal(submittedPrompt['3'].inputs.denoise, 0.73);
    assert.equal(submittedPrompt['3'].inputs.seed, 99);
    assert.equal(result.metadata.startImage, true);
    assert.equal(result.metadata.manifestProfileId, 'test-keyframe-i2i');
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
test('ComfyUI provider generates image candidates through an explicit manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-comfyui-image-'));
  const workflowPath = join(root, 'image-workflow.json');
  const manifestPath = join(root, 'image-manifest.json');
  const mediaRoot = join(root, 'media');
  await writeFile(workflowPath, JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'old', images: ['8', 0] } },
  }));
  await writeFile(manifestPath, JSON.stringify({
    profileId: 'test-t2i', mode: 't2i',
    positivePrompt: { node: '6', field: 'text' }, negativePrompt: { node: '7', field: 'text' },
    seedInputs: [{ node: '3', field: 'seed' }], width: { node: '5', field: 'width' },
    height: { node: '5', field: 'height' }, filenamePrefix: { node: '9', field: 'filename_prefix' }, outputNode: '9',
  }));
  let submittedPrompt;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/prompt') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submittedPrompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: 'image-1' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/history/image-1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ 'image-1': { outputs: { '9': { images: [{ filename: 'candidate.png', subfolder: 'wenying', type: 'output' }] } } } }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('fake-png'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const provider = new ComfyUiMediaProvider({
      baseUrl: `http://127.0.0.1:${address.port}`, workflowPath,
      imageWorkflowPath: workflowPath, imageWorkflowManifestPath: manifestPath,
      mediaRoot, pollMs: 1, timeoutMs: 10_000, negativePrompt: 'blurry',
    });
    const result = await provider.generateImage({
      project: { id: 'project-1' }, prompt: '沈砚正面角色设定图', seed: 77, filenamePrefix: 'character_front',
      width: 576, height: 1024, metadata: { entityId: 'character_1' },
    });
    assert.equal(submittedPrompt['6'].inputs.text, '沈砚正面角色设定图');
    assert.equal(submittedPrompt['7'].inputs.text, 'blurry');
    assert.equal(submittedPrompt['3'].inputs.seed, 77);
    assert.equal(submittedPrompt['5'].inputs.width, 576);
    assert.equal(submittedPrompt['5'].inputs.height, 1024);
    assert.match(submittedPrompt['9'].inputs.filename_prefix, /^wenying\/project-1\/visual-assets\/character_front/);
    assert.match(result.objectKey, /^projects\/project-1\/visual-assets\/character_front-77-[a-f0-9]{8}\.png$/);
    assert.match(result.metadata.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(join(mediaRoot, result.objectKey)), Buffer.from('fake-png'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('image candidates are written to a new path per prompt so regeneration never overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-comfyui-unique-'));
  const workflowPath = join(root, 'image-workflow.json');
  const manifestPath = join(root, 'image-manifest.json');
  const mediaRoot = join(root, 'media');
  await writeFile(workflowPath, JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'old', images: ['8', 0] } },
  }));
  await writeFile(manifestPath, JSON.stringify({
    profileId: 'test-image-t2i', mode: 't2i',
    positivePrompt: { node: '6', field: 'text' }, negativePrompt: { node: '7', field: 'text' },
    seedInputs: [{ node: '3', field: 'seed' }], width: { node: '5', field: 'width' }, height: { node: '5', field: 'height' },
    filenamePrefix: { node: '9', field: 'filename_prefix' }, outputNode: '9', requiresStartImage: false,
  }));
  let counter = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/prompt') {
      for await (const chunk of req) { /* drain */ }
      counter += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: `image-${counter}` }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/history/image-')) {
      const id = req.url.split('/').pop();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ [id]: { outputs: { '9': { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } } } }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('fake-png'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const provider = new ComfyUiMediaProvider({
      baseUrl: `http://127.0.0.1:${address.port}`, workflowPath,
      imageWorkflowPath: workflowPath, imageWorkflowManifestPath: manifestPath,
      mediaRoot, pollMs: 1, timeoutMs: 10_000, negativePrompt: 'blurry',
    });
    const prefix = 'reference_scene_scene_1_master_1';
    const first = await provider.generateImage({ project: { id: 'project-1' }, prompt: '开阔的青石板广场', seed: 0, filenamePrefix: prefix });
    const edited = await provider.generateImage({ project: { id: 'project-1' }, prompt: '宗门中央觉醒广场，紫色灵力光柱', seed: 0, filenamePrefix: prefix });
    const repeat = await provider.generateImage({ project: { id: 'project-1' }, prompt: '开阔的青石板广场', seed: 0, filenamePrefix: prefix });

    // 提示词改了 → 新文件，旧候选仍然是旧内容
    assert.notEqual(edited.objectKey, first.objectKey);
    assert.match(first.objectKey, /^projects\/project-1\/visual-assets\/reference_scene_scene_1_master_1-0-[a-f0-9]{8}\.png$/);
    // 同样的输入重跑 → 同一个路径，不产生无意义的重复文件
    assert.equal(repeat.objectKey, first.objectKey);
    assert.deepEqual(await readFile(join(mediaRoot, first.objectKey)), Buffer.from('fake-png'));
    assert.deepEqual(await readFile(join(mediaRoot, edited.objectKey)), Buffer.from('fake-png'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('multi reference manifests upload every reference image for edit workflows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wenying-comfyui-multiref-'));
  const characterPath = join(root, 'character.png');
  const scenePath = join(root, 'scene.png');
  const mediaRoot = join(root, 'media');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7x0AAAAASUVORK5CYII=', 'base64');
  await writeFile(characterPath, png);
  await writeFile(scenePath, png);

  let uploads = 0;
  let submittedPrompt;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/upload/image') {
      for await (const chunk of req) { /* drain */ }
      uploads += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: `reference-${uploads}.png`, subfolder: 'wenying/test', type: 'input' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/prompt') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      submittedPrompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: 'multi-1' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/history/multi-1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ 'multi-1': { outputs: { '9': { images: [{ filename: 'keyframe.png', subfolder: 'wenying', type: 'output' }] } } } }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('fake-keyframe'));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const provider = new ComfyUiMediaProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      workflowPath: resolve('workflows/krea2-keyframe-img2img-api.json'),
      keyframeWorkflowPath: resolve('workflows/qwen-image-edit-keyframe-api.json'),
      keyframeWorkflowManifestPath: resolve('workflows/manifests/qwen-image-edit-keyframe.json'),
      keyframeDenoise: 1, useReferenceForKeyframes: true,
      mediaRoot, pollMs: 1, timeoutMs: 10_000, negativePrompt: 'blurry',
    });
    const result = await provider.generateImage({
      project: { id: 'project-1' },
      prompt: '张元站在人群中低头把玩彩色石头，中景仰角三分法',
      negativePrompt: '分格，拼贴',
      seed: 7,
      filenamePrefix: 'keyframe_shot-1_1',
      referenceImagePath: characterPath,
      referenceImagePaths: [scenePath],
    });

    assert.equal(uploads, 3, '主参考图和两个场景参考槽都要有有效上传图');
    assert.equal(submittedPrompt['10'].inputs.image, 'wenying/test/reference-1.png');
    assert.equal(submittedPrompt['11'].inputs.image, 'wenying/test/reference-2.png');
    assert.equal(submittedPrompt['14'].inputs.image, 'wenying/test/reference-3.png');
    assert.match(submittedPrompt['6'].inputs.prompt, /张元站在人群中/);
    assert.equal(submittedPrompt['7'].inputs.prompt, '分格，拼贴');
    assert.equal(submittedPrompt['7'].inputs.image1[0], '5', '负向分支也要带上被编辑的场景画布');
    assert.equal(submittedPrompt['7'].inputs.image2[0], '11', '负向分支也要带上角色参考图');
    assert.equal(submittedPrompt['5'].inputs.width, 576);
    assert.equal(submittedPrompt['5'].inputs.height, 1024);
    assert.equal(submittedPrompt['3'].inputs.denoise, 1);
    assert.equal(result.metadata.startImage, true);
    assert.equal(result.metadata.referenceImagesUsed, 2);
    assert.deepEqual(result.metadata.companionReferenceImagePaths, [scenePath]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('keeps the Qwen-Image-Edit-2511 GGUF keyframe workflow aligned with the official template', async () => {
  const workflowPath = resolve('workflows/qwen-image-edit-keyframe-api.json');
  const manifestPath = resolve('workflows/manifests/qwen-image-edit-keyframe.json');
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  const manifest = await loadWorkflowManifest(manifestPath);

  // 2511 走 GGUF：加载器必须是 GGUF 版本，否则远程 ComfyUI 找不到权重。
  assert.equal(workflow['1'].class_type, 'UnetLoaderGGUF');
  assert.match(workflow['1'].inputs.unet_name, /^qwen-image-edit-2511-.+\.gguf$/);
  assert.equal(workflow['2'].class_type, 'CLIPLoaderGGUF');
  assert.equal(workflow['2'].inputs.type, 'qwen_image');
  assert.match(workflow['2'].inputs.clip_name, /^Qwen2\.5-VL-7B-Instruct-.+\.gguf$/);

  // 2511 官方参数与 2509 不同：cfg 4（2509 是 2.5）、shift 3.1（2509 是 3）。
  assert.equal(workflow['3'].inputs.cfg, 4);
  assert.equal(workflow['3'].inputs.steps, 20);
  assert.equal(workflow['50'].inputs.shift, 3.1);
  assert.equal(workflow['60'].class_type, 'CFGNorm');
  assert.deepEqual(workflow['60'].inputs.model, ['50', 0]);
  assert.deepEqual(workflow['3'].inputs.model, ['60', 0]);

  // 正负两路都接参考图，并各自带一个多参考 latents 声明。
  for (const nodeId of ['6', '7']) {
    assert.equal(workflow[nodeId].class_type, 'TextEncodeQwenImageEditPlus');
    assert.deepEqual(workflow[nodeId].inputs.image1, ['5', 0]);
    assert.deepEqual(workflow[nodeId].inputs.image2, ['11', 0]);
    assert.deepEqual(workflow[nodeId].inputs.image3, ['14', 0]);
  }

  // 官方 2511 模板把 image1 经缩放后 VAEEncode 成采样器的 latent_image：
  // image1 是"被编辑的画布"，所以它必须是场景图，角色只能当补充参考图。
  assert.equal(workflow['5'].class_type, 'ImageScale');
  assert.deepEqual(workflow['5'].inputs.image, ['10', 0]);
  assert.equal(workflow['5'].inputs.width, 576);
  assert.equal(workflow['5'].inputs.height, 1024);
  assert.equal(workflow['15'].class_type, 'VAEEncode');
  assert.deepEqual(workflow['15'].inputs.pixels, ['5', 0]);
  assert.deepEqual(workflow['15'].inputs.vae, ['4', 0]);
  assert.deepEqual(workflow['3'].inputs.latent_image, ['15', 0]);
  assert.equal(workflow['12'].class_type, 'FluxKontextMultiReferenceLatentMethod');
  assert.equal(workflow['13'].class_type, 'FluxKontextMultiReferenceLatentMethod');
  assert.deepEqual(workflow['12'].inputs.conditioning, ['6', 0]);
  assert.deepEqual(workflow['13'].inputs.conditioning, ['7', 0]);
  assert.equal(workflow['12'].inputs.reference_latents_method, 'index_timestep_zero');
  assert.equal(workflow['13'].inputs.reference_latents_method, 'index_timestep_zero');
  assert.deepEqual(workflow['3'].inputs.positive, ['12', 0]);
  assert.deepEqual(workflow['3'].inputs.negative, ['13', 0]);

  // manifest 要把运行时的提示词、参考图、seed、尺寸写到 2511 工作流的对应节点。
  const prepared = structuredClone(workflow);
  applyWorkflowManifest(prepared, manifest, {
    positivePrompt: '把角色放进广场',
    negativePrompt: '分格，拼贴',
    startImage: 'wenying/test/character.png',
    referenceImages: ['wenying/test/scene-front.png', 'wenying/test/scene-side.png'],
    seed: 7,
    width: 576,
    height: 1024,
    denoise: 1,
  });
  assert.equal(prepared['6'].inputs.prompt, '把角色放进广场');
  assert.equal(prepared['7'].inputs.prompt, '分格，拼贴');
  assert.equal(prepared['10'].inputs.image, 'wenying/test/character.png');
  assert.equal(prepared['11'].inputs.image, 'wenying/test/scene-front.png');
  assert.equal(prepared['14'].inputs.image, 'wenying/test/scene-side.png');
  assert.equal(prepared['3'].inputs.seed, 7);
  assert.equal(prepared['3'].inputs.denoise, 1);
  assert.equal(prepared['5'].inputs.width, 576);
  assert.equal(prepared['5'].inputs.height, 1024);

  const pair = await verifyWorkflowPair(workflowPath, manifestPath);
  assert.equal(pair.mode, 'i2i');
  assert.equal(pair.mode, pair.declaredMode);
});
