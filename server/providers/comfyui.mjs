import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { optionalPrompt, renderPrompt } from '../prompt-config.mjs';
import { applyWorkflowManifest, loadWorkflowManifest, validateWorkflowForManifest, verifyWorkflowPair } from '../workflow-manifest.mjs';
import { probeMedia } from '../media-probe.mjs';

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

export class ComfyUiError extends Error {
  constructor(message, code = 'COMFYUI_ERROR', details = null) {
    super(message);
    this.name = 'ComfyUiError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Remote ComfyUI provider.
 *
 * The browser never talks to ComfyUI directly. This provider submits an API
 * workflow, waits for the remote history entry, downloads the output through
 * /view, and stores a local copy under MEDIA_OUTPUT_DIR.
 */
export class ComfyUiMediaProvider {
  constructor({
    baseUrl,
    workflowPath,
    workflowManifestPath = '',
    imageWorkflowPath = '',
    imageWorkflowManifestPath = '',
    keyframeWorkflowPath = '',
    keyframeWorkflowManifestPath = '',
    scenePlateWorkflowPath = '',
    scenePlateWorkflowManifestPath = '',
    keyframeDenoise = 0.82,
    useReferenceForKeyframes = true,
    imageNegativePrompt = '',
    imageWidth = 576,
    imageHeight = 1024,
    mediaRoot = './data/media',
    timeoutMs = 900000,
    pollMs = 1000,
    apiKey = '',
    authToken = '',
    basicAuth = '',
    inputImagePath = '',
    width = 576,
    height = 1024,
    frames = 121,
    fps = 24,
    fixedSeed = '',
    negativePrompt = '',
    ffprobePath = '',
  } = {}) {
    this.provider = 'comfyui';
    this.model = 'comfyui-workflow';
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.workflowPath = workflowPath ? resolve(workflowPath) : '';
    this.workflowManifestPath = workflowManifestPath ? resolve(workflowManifestPath) : '';
    this.imageWorkflowPath = imageWorkflowPath ? resolve(imageWorkflowPath) : '';
    this.imageWorkflowManifestPath = imageWorkflowManifestPath ? resolve(imageWorkflowManifestPath) : '';
    this.keyframeWorkflowPath = keyframeWorkflowPath ? resolve(keyframeWorkflowPath) : '';
    this.keyframeWorkflowManifestPath = keyframeWorkflowManifestPath ? resolve(keyframeWorkflowManifestPath) : '';
    this.scenePlateWorkflowPath = scenePlateWorkflowPath ? resolve(scenePlateWorkflowPath) : '';
    this.scenePlateWorkflowManifestPath = scenePlateWorkflowManifestPath ? resolve(scenePlateWorkflowManifestPath) : '';
    this.keyframeDenoise = Math.max(0, Math.min(1, Number(keyframeDenoise) || 0.82));
    this.useReferenceForKeyframes = Boolean(useReferenceForKeyframes);
    this.imageNegativePrompt = String(imageNegativePrompt || '');
    this.imageWidth = Math.max(64, Number(imageWidth) || 576);
    this.imageHeight = Math.max(64, Number(imageHeight) || 1024);
    this.mediaRoot = resolve(mediaRoot || './data/media');
    this.timeoutMs = Math.max(10_000, Number(timeoutMs) || 900000);
    this.pollMs = Math.max(250, Number(pollMs) || 1000);
    this.apiKey = String(apiKey || '');
    this.authToken = String(authToken || '');
    this.basicAuth = String(basicAuth || '');
    this.inputImagePath = inputImagePath ? resolve(inputImagePath) : '';
    this.width = Math.max(64, Number(width) || 576);
    this.height = Math.max(64, Number(height) || 1024);
    this.frames = Math.max(1, Number(frames) || 121);
    this.fps = Math.max(1, Number(fps) || 24);
    this.fixedSeed = fixedSeed === '' || fixedSeed === undefined ? null : Number(fixedSeed);
    this.negativePrompt = String(negativePrompt || '');
    this.ffprobePath = ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  }

  /**
   * 只读自检：确认每一组“工作流 + manifest”都存在、配对且形态一致。
   * 在服务启动时调用，避免跑到生成阶段才发现配错了档案。
   */
  async verifyWorkflows() {
    const pairs = [
      { label: 'video', workflowPath: this.workflowPath, manifestPath: this.workflowManifestPath },
      { label: 'image', workflowPath: this.imageWorkflowPath, manifestPath: this.imageWorkflowManifestPath },
      { label: 'keyframe', workflowPath: this.keyframeWorkflowPath, manifestPath: this.keyframeWorkflowManifestPath },
      { label: 'scene-plate', workflowPath: this.scenePlateWorkflowPath, manifestPath: this.scenePlateWorkflowManifestPath },
    ];
    const results = [];
    for (const pair of pairs) {
      if (!pair.workflowPath) {
        results.push({ ...pair, configured: false, ok: false, error: new ComfyUiError('未配置工作流路径', 'COMFYUI_NOT_CONFIGURED') });
        continue;
      }
      try {
        const verified = await verifyWorkflowPair(pair.workflowPath, pair.manifestPath);
        results.push({ ...pair, ...verified, ok: true });
      } catch (error) {
        results.push({ ...pair, configured: true, ok: false, error });
      }
    }
    return results;
  }

  async generateVideo({ project, segmentVersion, shot = null, startImagePath = null, keyframeAsset = null, generationSignature = null }) {
    this.assertConfigured();
    const manifest = await loadWorkflowManifest(this.workflowManifestPath);
    const clientId = randomUUID();
    const workflow = await this.loadWorkflow(this.workflowPath, manifest);
    const uploadedImage = await this.uploadInputImage(clientId, startImagePath || segmentVersion.first_frame_path || this.inputImagePath);
    const prepared = this.preparePrompt(workflow, { project, segmentVersion, shot, uploadedImage, manifest });
    const prompt = prepared.prompt;
    const submitted = await this.requestJson('/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt, client_id: clientId }),
    });
    if (!submitted?.prompt_id) {
      throw new ComfyUiError('ComfyUI 未返回 prompt_id', 'COMFYUI_SUBMIT_FAILED', submitted);
    }

    const output = await this.waitForOutput(submitted.prompt_id);
    const objectKey = join(
      'projects',
      safePart(project.id),
      'segments',
      safePart(segmentVersion.segment_id || 'segment'),
      'versions',
       safePart(segmentVersion.id),
       shot ? 'shots' : '',
       shot ? safePart(shot.id) : '',
       shot ? `video${output.extension}` : `video${output.extension}`,
    ).replaceAll('\\', '/');
    const outputPath = resolve(this.mediaRoot, objectKey);
    await mkdir(dirname(outputPath), { recursive: true });

    const response = await this.request(`/view?${new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder || '',
      type: output.type || 'output',
    })}`);
    const data = Buffer.from(await response.arrayBuffer());
    await writeFile(outputPath, data);
    const probe = await probeMedia(outputPath, { ffprobePath: this.ffprobePath, optional: true });
    const requestedDurationMs = Number(shot?.duration_ms || segmentVersion.duration_ms || 0);

    return {
      objectKey,
      durationMs: probe?.durationMs || requestedDurationMs,
      sizeBytes: probe?.sizeBytes || data.length,
      metadata: {
        promptId: submitted.prompt_id,
        filename: output.filename,
        subfolder: output.subfolder || '',
        type: output.type || 'output',
        workflowPath: this.workflowPath,
        workflowManifestPath: this.workflowManifestPath || null,
        generationSignature,
        keyframeAssetId: keyframeAsset?.id || null,
        startImage: Boolean(uploadedImage),
        width: probe?.width || this.width,
        height: probe?.height || this.height,
        frames: prepared.frames,
        fps: this.fps,
        requestedDurationMs,
        actualDurationMs: probe?.durationMs || null,
        prompt: prepared.positiveText,
        negativePrompt: prepared.negativeText,
        seed: prepared.seed,
        workflowHash: prepared.workflowHash,
        probe,
        shotId: shot?.id || null,
      },
    };
  }

  async generateImage({
    project, prompt, negativePrompt = '', seed, filenamePrefix = 'image',
    width, height, referenceImagePath = null, referenceImagePaths = [], metadata = {}, negativeOverride = false,
    denoise, mode = 'auto',
  }) {
    const requestedEditWorkflow = mode === 'scenePlate' ? this.scenePlateWorkflowPath : this.keyframeWorkflowPath;
    const requestedEditManifest = mode === 'scenePlate' ? this.scenePlateWorkflowManifestPath : this.keyframeWorkflowManifestPath;
    const useReference = Boolean(referenceImagePath && requestedEditWorkflow && this.useReferenceForKeyframes);
    const workflowPath = useReference ? requestedEditWorkflow : this.imageWorkflowPath;
    const manifestPath = useReference ? requestedEditManifest : this.imageWorkflowManifestPath;
    this.assertConfigured(workflowPath);
    const manifest = await loadWorkflowManifest(manifestPath);
    const workflow = await this.loadWorkflow(workflowPath, manifest);
    const imageWidth = Math.max(64, Number(width || this.imageWidth) || 576);
    const imageHeight = Math.max(64, Number(height || this.imageHeight) || 1024);
    const requestedDenoise = denoise === undefined || denoise === null || denoise === '' ? NaN : Number(denoise);
    const imageDenoise = Number.isFinite(requestedDenoise)
      ? Math.max(0, Math.min(1, requestedDenoise))
      : this.keyframeDenoise;
    const imageSeed = seed === undefined || seed === null || seed === '' ? Math.floor(Math.random() * 2 ** 31) : Number(seed);
    const clientId = randomUUID();
    const uploadedImage = useReference ? await this.uploadInputImage(clientId, referenceImagePath) : null;
    // 补充参考图：多图编辑工作流（Qwen-Image-Edit / Kontext 等）会按 manifest.referenceImages
    // 把它们接到第二个、第三个 LoadImage 上；单图 img2img 工作流拿不到映射会自动忽略。
    const companionSlots = Array.isArray(manifest?.referenceImages) ? manifest.referenceImages.length : 0;
    const uploadedCompanions = [];
    if (useReference && companionSlots > 0) {
      const mappedPaths = referenceImagePaths.filter(Boolean).slice(0, companionSlots);
      const fallbackPath = mappedPaths.at(-1) || referenceImagePath;
      while (mappedPaths.length < companionSlots && fallbackPath) mappedPaths.push(fallbackPath);
      for (const companionPath of mappedPaths) {
        if (!companionPath) continue;
        const uploaded = await this.uploadInputImage(clientId, companionPath);
        if (uploaded) uploadedCompanions.push(uploaded);
      }
    }
    // negativeOverride=true 时调用方已经编译好了完整负向词（含镜头 mustNotShow 与保护概念），
    // 这里不再自动拼接全局负面词，避免出现“要求闪烁又禁止闪烁”这类冲突。
    const combinedNegative = negativeOverride && negativePrompt
      ? negativePrompt
      : [this.imageNegativePrompt, negativePrompt || this.negativePrompt].filter(Boolean).join('，');
    const prepared = this.prepareImageWorkflow(workflow, {
      prompt: String(prompt || ''),
      negativePrompt: combinedNegative,
      seed: imageSeed,
      width: imageWidth,
      height: imageHeight,
      denoise: imageDenoise,
      startImage: uploadedImage || undefined,
      referenceImages: uploadedCompanions,
      filenamePrefix: `wenying/${safePart(project.id)}/visual-assets/${safePart(filenamePrefix)}`,
      manifest,
    });
    const submitted = await this.requestJson('/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt: prepared.prompt, client_id: clientId }),
    });
    if (!submitted?.prompt_id) throw new ComfyUiError('ComfyUI 未返回 prompt_id', 'COMFYUI_SUBMIT_FAILED', submitted);
    const output = await this.waitForOutput(submitted.prompt_id, 'image');
    const response = await this.request(`/view?${new URLSearchParams({
      filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output',
    })}`);
    const data = Buffer.from(await response.arrayBuffer());
    const extension = output.extension || '.png';
    // 文件名带上工作流内容指纹：改提示词或换 seed 都会落到新路径，
    // 不会再把上一轮候选覆盖掉（旧行为会让“重新生成”看起来和第一次一模一样）。
    const contentToken = String(prepared.workflowHash || '').slice(0, 8)
      || createHash('sha256').update(`${filenamePrefix}:${imageSeed}:${prompt}`).digest('hex').slice(0, 8);
    const objectKey = `projects/${safePart(project.id)}/visual-assets/${safePart(filenamePrefix)}-${imageSeed}-${contentToken}${extension}`;
    const outputPath = resolve(this.mediaRoot, objectKey);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    return {
      objectKey,
      durationMs: 0,
      sizeBytes: data.length,
      metadata: {
        ...metadata,
        promptId: submitted.prompt_id,
        filename: output.filename,
        subfolder: output.subfolder || '',
        type: output.type || 'output',
        workflowPath,
        workflowManifestPath: manifestPath || null,
        generationMode: mode,
        manifestProfileId: prepared.manifestProfileId,
        width: imageWidth,
        height: imageHeight,
        prompt: prepared.positiveText,
        negativePrompt: prepared.negativeText,
        seed: prepared.seed,
        workflowHash: prepared.workflowHash,
        startImage: Boolean(uploadedImage),
        referenceImagePath: referenceImagePath || null,
        companionReferenceImagePaths: referenceImagePaths.filter(Boolean),
        referenceImagesUsed: uploadedCompanions.length,
        sha256,
      },
    };
  }
  prepareImageWorkflow(prompt, { prompt: positiveText, negativePrompt, seed, width, height, denoise, startImage, referenceImages = [], filenamePrefix, manifest = null }) {
    if (manifest) {
      applyWorkflowManifest(prompt, manifest, {
        positivePrompt: positiveText,
        negativePrompt,
        seed,
        width,
        height,
        denoise,
        startImage,
        referenceImages,
      });
      if (manifest.filenamePrefix) setManifestValue(prompt, manifest.filenamePrefix, filenamePrefix);
      const workflowHash = createHash('sha256').update(JSON.stringify(prompt)).digest('hex');
      return { prompt, positiveText, negativeText: negativePrompt, seed, workflowHash, manifestProfileId: manifest.profileId };
    }
    let positiveSet = false;
    let negativeSet = false;
    let seedSet = false;
    let sizeSet = false;
    let prefixSet = false;
    for (const [, node] of Object.entries(prompt)) {
      if (!node?.inputs) continue;
      const classType = String(node.class_type || '').toLowerCase();
      const title = String(node._meta?.title || '').toLowerCase();
      if (classType.includes('cliptextencode') && typeof node.inputs.text === 'string') {
        const isNegative = title.includes('negative') || title.includes('反向') || title.includes('负面') || (!positiveSet && negativeSet);
        if (isNegative && !negativeSet) { node.inputs.text = negativePrompt; negativeSet = true; }
        else if (!positiveSet) { node.inputs.text = positiveText; positiveSet = true; }
        else if (!negativeSet) { node.inputs.text = negativePrompt; negativeSet = true; }
      }
      if (['ksampler', 'ksampleradvanced'].includes(classType) && 'seed' in node.inputs) { node.inputs.seed = seed; seedSet = true; }
      if (classType === 'emptylatentimage') {
        if ('width' in node.inputs) { node.inputs.width = width; sizeSet = true; }
        if ('height' in node.inputs) node.inputs.height = height;
      }
      if (classType === 'saveimage' && 'filename_prefix' in node.inputs) { node.inputs.filename_prefix = filenamePrefix; prefixSet = true; }
      if (startImage && classType === 'loadimage' && 'image' in node.inputs) node.inputs.image = startImage;
    }
    if (!positiveSet || !negativeSet || !seedSet || !sizeSet || !prefixSet) {
      throw new ComfyUiError('图片工作流缺少必需的正负提示、seed、尺寸或 SaveImage 节点，请配置 manifest', 'COMFYUI_IMAGE_WORKFLOW_INVALID');
    }
    const workflowHash = createHash('sha256').update(JSON.stringify(prompt)).digest('hex');
    return { prompt, positiveText, negativeText: negativePrompt, seed, workflowHash, manifestProfileId: null };
  }
  assertConfigured(workflowPath = this.workflowPath) {
    if (!this.baseUrl) throw new ComfyUiError('未配置 COMFYUI_BASE_URL', 'COMFYUI_NOT_CONFIGURED');
    if (!workflowPath) throw new ComfyUiError('未配置 ComfyUI 工作流路径', 'COMFYUI_NOT_CONFIGURED');
  }

  async loadWorkflow(path = this.workflowPath, manifest = null) {
    let contents;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      throw new ComfyUiError(`无法读取 ComfyUI 工作流文件：${path}`, 'COMFYUI_WORKFLOW_NOT_FOUND', error.message);
    }
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new ComfyUiError('ComfyUI 工作流 JSON 格式无效', 'COMFYUI_WORKFLOW_INVALID', error.message);
    }
    const prompt = parsed?.prompt && typeof parsed.prompt === 'object' && !Array.isArray(parsed.prompt)
      ? parsed.prompt
      : parsed;
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt) || prompt.nodes) {
      throw new ComfyUiError('工作流必须是 ComfyUI 的 Save (API Format) JSON', 'COMFYUI_WORKFLOW_INVALID');
    }
    const workflow = structuredClone(prompt);
    validateWorkflowForManifest(workflow, manifest);
    return workflow;
  }

  async uploadInputImage(clientId, imagePath) {
    
    if (!imagePath) return null;
    let data;
    try {
      data = await readFile(imagePath);
    } catch (error) {
      throw new ComfyUiError(`无法读取首帧图片：${imagePath}`, 'COMFYUI_INPUT_IMAGE_NOT_FOUND', error.message);
    }
    const form = new FormData();
    form.append('image', new Blob([data]), basename(imagePath));
    form.append('overwrite', 'true');
    form.append('type', 'input');
    form.append('subfolder', `wenying/${clientId}`);
    const payload = await this.requestJson('/upload/image', { method: 'POST', body: form });
    if (!payload?.name) throw new ComfyUiError('ComfyUI 图片上传失败', 'COMFYUI_UPLOAD_FAILED', payload);
    return payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name;
  }

  preparePrompt(prompt, { project, segmentVersion, shot, uploadedImage, manifest = null }) {
    const fallbackText = renderPrompt(optionalPrompt('VIDEO_FINAL_FALLBACK_PROMPT_TEMPLATE'), {
      genre: project.genre,
      scriptText: segmentVersion.script_text || '',
    });
    const spec = shot?.generation_spec || {};
    const positiveText = String(spec.motionPrompt || shot?.prompt_zh || segmentVersion.prompt_text || segmentVersion.script_text || fallbackText);
    const negativeText = compileNegativePrompt(this.negativePrompt, spec.mustNotShow, spec.protectedPositiveConcepts || spec.mustShow);
    const requestedDurationMs = Number(shot?.duration_ms || segmentVersion.duration_ms || 0);
    const frames = wanFrameCount(requestedDurationMs, this.fps, this.frames);
    const seed = this.fixedSeed === null ? Math.floor(Math.random() * 2 ** 31) : this.fixedSeed;
    const filenamePrefix = `wenying_${safePart(project.id)}_${safePart(segmentVersion.id)}${shot ? `_${safePart(shot.id)}` : ''}`;

    if (manifest) {
      applyWorkflowManifest(prompt, manifest, {
        positivePrompt: positiveText,
        negativePrompt: negativeText,
        seed,
        width: this.width,
        height: this.height,
        frames,
        fps: this.fps,
        startImage: uploadedImage || undefined,
      });
      if (manifest.filenamePrefix) setManifestValue(prompt, manifest.filenamePrefix, filenamePrefix);
      const workflowHash = createHash('sha256').update(JSON.stringify(prompt)).digest('hex');
      return { prompt, positiveText, negativeText, seed, frames, workflowHash, manifestProfileId: manifest.profileId };
    }

    let positiveSet = false;
    let negativeSet = false;
    let startImageSet = false;
    for (const [, node] of Object.entries(prompt)) {
      if (!node || typeof node !== 'object' || !node.inputs) continue;
      const classType = String(node.class_type || '').toLowerCase();
      const title = String(node._meta?.title || '').toLowerCase();
      if (classType.includes('cliptextencode') && typeof node.inputs.text === 'string') {
        const isNegative = title.includes('negative') || title.includes('反向') || title.includes('负面') || (!positiveSet && negativeSet);
        if (isNegative && !negativeSet) {
          node.inputs.text = negativeText;
          negativeSet = true;
        } else if (!positiveSet) {
          node.inputs.text = positiveText;
          positiveSet = true;
        } else if (!negativeSet) {
          node.inputs.text = negativeText;
          negativeSet = true;
        }
      }
      if (uploadedImage && classType === 'loadimage' && 'image' in node.inputs) {
        node.inputs.image = uploadedImage;
        startImageSet = true;
      }
      if (['ksampler', 'ksampleradvanced'].includes(classType) && 'seed' in node.inputs) node.inputs.seed = seed;
      if (['savevideo', 'videocombine', 'vhs_videocombine', 'saveanimatedwebp'].includes(classType)) {
        if ('filename_prefix' in node.inputs) node.inputs.filename_prefix = filenamePrefix;
        if ('fps' in node.inputs) node.inputs.fps = this.fps;
        if ('frame_rate' in node.inputs) node.inputs.frame_rate = this.fps;
      }
      if (['createvideo', 'vhs_videocombine'].includes(classType)) {
        if ('fps' in node.inputs) node.inputs.fps = this.fps;
        if ('frame_rate' in node.inputs) node.inputs.frame_rate = this.fps;
      }
      if (classType.includes('wan') || classType.includes('emptylatentvideo') || classType.includes('videolatent')) {
        setIfPresent(node.inputs, 'width', this.width);
        setIfPresent(node.inputs, 'height', this.height);
        setIfPresent(node.inputs, 'length', frames);
        setIfPresent(node.inputs, 'num_frames', frames);
        setIfPresent(node.inputs, 'frames', frames);
      }
    }
    if (!positiveSet || !negativeSet) throw new ComfyUiError('工作流必须包含可替换的正向和负向文本节点', 'COMFYUI_WORKFLOW_MISSING_PROMPT');
    if (uploadedImage && !startImageSet) throw new ComfyUiError('工作流缺少 LoadImage 节点，无法消费已确认首帧', 'COMFYUI_START_IMAGE_NODE_MISSING');
    const workflowHash = createHash('sha256').update(JSON.stringify(prompt)).digest('hex');
    return { prompt, positiveText, negativeText, seed, frames, workflowHash, manifestProfileId: null };
  }
  async waitForOutput(promptId, kind = 'video') {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.timeoutMs) {
      const history = await this.requestJson(`/history/${encodeURIComponent(promptId)}`);
      const item = history?.[promptId];
      const status = String(item?.status?.status_str || '').toLowerCase();
      if (status === 'error' || status === 'failed') {
        throw new ComfyUiError('ComfyUI 工作流执行失败', 'COMFYUI_EXECUTION_FAILED', item?.status);
      }
      const output = kind === 'image' ? findImageOutput(item?.outputs) : findVideoOutput(item?.outputs);
      if (output) return output;
      await sleep(this.pollMs);
    }
    throw new ComfyUiError(`ComfyUI 执行超过 ${this.timeoutMs}ms`, 'COMFYUI_TIMEOUT');
  }

  async requestJson(path, options = {}) {
    const response = await this.request(path, options);
    try {
      return await response.json();
    } catch (error) {
      throw new ComfyUiError('ComfyUI 返回了无效 JSON', 'COMFYUI_INVALID_RESPONSE', error.message);
    }
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.apiKey) headers.set('X-API-Key', this.apiKey);
    if (this.authToken) headers.set('Authorization', `Bearer ${this.authToken}`);
    if (this.basicAuth) headers.set('Authorization', `Basic ${Buffer.from(this.basicAuth).toString('base64')}`);
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ComfyUiError(`无法连接 ComfyUI：${this.baseUrl}`, 'COMFYUI_UNREACHABLE', error.message);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ComfyUiError(`ComfyUI 请求失败（HTTP ${response.status}）`, 'COMFYUI_HTTP_ERROR', body.slice(0, 1000));
    }
    return response;
  }
}

function setIfPresent(inputs, key, value) {
  if (key in inputs && typeof inputs[key] !== 'object') inputs[key] = value;
}

export function wanFrameCount(durationMs, fps = 24, fallbackFrames = 121) {
  const duration = Number(durationMs);
  const rate = Number(fps);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(rate) || rate <= 0) {
    return Math.max(1, Number(fallbackFrames) || 121);
  }
  const desired = Math.max(1, Math.round(duration * rate / 1000));
  return 1 + 4 * Math.max(0, Math.round((desired - 1) / 4));
}

export function compileNegativePrompt(globalNegative, mustNotShow = [], protectedConcepts = []) {
  const protectedList = expandConceptAliases(normalizeTerms(protectedConcepts));
  const parts = String(globalNegative || '')
    .split(/[，,、;；\n]+/)
    .map(value => value.trim())
    .filter(Boolean)
    .filter(term => !protectedList.some(protectedTerm => conflicts(term, protectedTerm)));
  for (const item of normalizeTerms(mustNotShow)) {
    const term = `不要出现${item}`;
    if (!parts.includes(term)) parts.push(term);
  }
  return parts.join('，');
}

function normalizeTerms(value) {
  return (Array.isArray(value) ? value : [value]).map(item => String(item || '').trim()).filter(Boolean);
}

function conflicts(left, right) {
  const a = left.replace(/^(不要|禁止|避免|无)/, '').toLowerCase();
  const b = right.replace(/^(不要|禁止|避免|无)/, '').toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const threshold = /[\u3400-\u9fff]/.test(`${a}${b}`) ? 3 : 4;
  return a.length >= threshold && b.length >= threshold && (a.includes(b) || b.includes(a));
}

function expandConceptAliases(concepts) {
  const aliases = {
    '闪烁': ['flicker', 'flickering'],
    '文字': ['text'],
    '字幕': ['subtitle', 'captions'],
    '镜头晃动': ['camera shake', 'shaky camera'],
  };
  const output = [...concepts];
  for (const concept of concepts) {
    for (const [source, targets] of Object.entries(aliases)) {
      if (concept.includes(source)) output.push(...targets);
    }
  }
  return [...new Set(output)];
}

function findImageOutput(outputs) {
  if (!outputs || typeof outputs !== 'object') return null;
  const candidates = [];
  walk(outputs, value => {
    if (!value || typeof value !== 'object' || !value.filename) return;
    const extension = extname(String(value.filename)).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
      candidates.push({
        filename: String(value.filename),
        subfolder: String(value.subfolder || ''),
        type: String(value.type || 'output'),
        extension,
      });
    }
  });
  return candidates[0] || null;
}

function setManifestValue(workflow, spec, value) {
  const node = workflow[String(spec.node)];
  if (!node?.inputs || !(spec.field in node.inputs)) {
    throw new ComfyUiError(`manifest 字段指向不存在的输入 ${spec.node}.${spec.field}`, 'COMFYUI_WORKFLOW_MANIFEST_INVALID');
  }
  node.inputs[spec.field] = value;
}
function findVideoOutput(outputs) {
  if (!outputs || typeof outputs !== 'object') return null;
  const candidates = [];
  walk(outputs, value => {
    if (!value || typeof value !== 'object' || !value.filename) return;
    const extension = extname(String(value.filename)).toLowerCase();
    if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.gif'].includes(extension)) {
      candidates.push({
        filename: String(value.filename),
        subfolder: String(value.subfolder || ''),
        type: String(value.type || 'output'),
        extension,
      });
    }
  });
  return candidates[0] || null;
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walk(item, visit);
  }
}

function safePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}
