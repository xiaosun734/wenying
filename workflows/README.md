# ComfyUI 工作流目录

把在远程 ComfyUI 页面通过 `Workflow -> Save (API Format)` 导出的 JSON 放到这里。

## 当前启用的工作流

| 环节 | 工作流 | manifest | 模型 |
|---|---|---|---|
| 视频（图生视频） | `video_wan2_2_5b_i2v_api.json` | `manifests/wan22-5b-i2v.json` | Wan 2.2 TI2V 5B |
| 人物视图 / 场景母版（文生图） | `z-image-turbo-t2i-api.json` | `manifests/z-image-turbo-t2i.json` | Z-Image Turbo |
| 关键帧（单图图生图） | `krea2-keyframe-img2img-api.json` | `manifests/krea2-keyframe-img2img.json` | Krea2-Turbo Realistic v3 |
| 关键帧（多图参考编辑） | `qwen-image-edit-keyframe-api.json` | `manifests/qwen-image-edit-keyframe.json` | Qwen-Image-Edit-2511（GGUF Q4_K_M） |

对应 `.env` 变量：`COMFYUI_WORKFLOW_PATH` / `COMFYUI_IMAGE_WORKFLOW_PATH` / `COMFYUI_KEYFRAME_WORKFLOW_PATH`，以及同名的 `*_MANIFEST_PATH`。

## 未启用的文件

以下文件当前没有被 `.env` 引用，保留作备选：

- `krea2-turbo-t2i-api.json` + `manifests/krea2-turbo-t2i.json`：Krea2 的文生图版本，与 Z-Image 结构一致，可以整体替换图像工作流。
- `sunn 9.9文生图.json`：早期导入的第三方文生图工作流，没有对应 manifest。

## 关键帧：谁当画布，谁当参考

`krea2-keyframe-img2img-api.json` 是单图 img2img：`LoadImage → VAEEncode → KSampler`，只能接收一张参考图。关键帧工作流切到它时，镜头同时锁定了角色和场景也只会用上一张，另一张只存在于提示词文字里。

`qwen-image-edit-keyframe-api.json` 用的是 Qwen-Image-Edit 的多图编辑节点 `TextEncodeQwenImageEditPlus`。要理解它是**编辑模型**：`image1` 不是“一张参考图”，而是**被编辑的画布**——官方 2509/2511 模板会把 `image1` 缩放后 `VAEEncode` 成 KSampler 的 `latent_image`，输出构图基本跟着这张图走。所以本项目按下面的分工传图：

- 画布（`startImage` / `referenceImagePath`）= **场景参考图**，优先选与镜头机位最接近的那张场景视图；
- 参考图 2 = **角色三视图**，只锁定身份、脸、发型、服装和身体比例；
- 参考图 3 = 同一场景的**另一机位**，帮助模型理解空间结构。

manifest 里的 `startImage` / `referenceImages` 就是这三张图的槽位：

```json
"startImage":      { "node": "10", "field": "image" },
"referenceImages": [{ "node": "11", "field": "image" }, { "node": "14", "field": "image" }],
```

`node 10` 是画布槽位，`node 5` 把它缩放到目标尺寸，`node 15` 把它编码成采样器的 `latent_image`；`node 11` / `node 14` 是两张补充参考图。**不要把角色三视图放进画布槽位**：那样模型会去“编辑三视图本身”，产出往往是一张孤立的角色立绘，场景参考图几乎不起作用。

提示词同样按这个分工写：参考图负责“角色长什么样、场景在哪里”，正文只写“角色在这个场景里做什么、怎么拍、画面最终长什么样”。服务会在正文前自动补一段 `Reference Image Roles` 说明每张图的职责，正文里不再复述整套人物与场景设定。实测（同一工作流、同一种子、同一画布）：把人物设定、场景设定、光照、一致性要求全部展开成多段规格说明后，参考图的控制力会被冲掉，模型会退回成“单独画一个人”。

这个工作流用的是 GGUF 量化权重，加载节点是 `UnetLoaderGGUF` / `CLIPLoaderGGUF`，需要远程 ComfyUI 装好 **ComfyUI-GGUF** 自定义节点。采样参数按 2511 官方模板设置：`cfg=4.0`、`ModelSamplingAuraFlow shift=3.1`、`steps=20`；正向和负向都用 `TextEncodeQwenImageEditPlus` 并同时接收三张图，两条条件链最后各接一个 `FluxKontextMultiReferenceLatentMethod`（`index_timestep_zero`）。

模型文件要求、切换步骤和自检命令见根目录 `COMFYUI_REMOTE_SETUP.md` 第 6 节，自检命令：

```bash
npm run check:keyframe-edit
```

## 工作流与 manifest 为什么要配对

manifest 用节点编号（`node` + `field`）描述“提示词、seed、尺寸、首帧、帧率”往哪里写。换个工作流而沿用旧 manifest，即使碰巧能跑通，也会跑错模型或者让 `KEYFRAME_DENOISE`、`FRAMES`、`FPS` 这类运行时配置被静默忽略。

服务启动时会自动做一次配对自检并打印结果，例如：

```text
ComfyUI video 工作流：i2v / wan22-5b-i2v-draft
ComfyUI image 工作流：t2i / z-image-turbo-t2i
ComfyUI keyframe 工作流：i2i / krea2-keyframe-img2img
```

配对失败时会打印 `工作流配置有误：...`，并在生成时抛出 `WORKFLOW_MANIFEST_MODE_MISMATCH`、`WORKFLOW_MANIFEST_NODE_MISSING` 等明确错误码。

详细配置见项目根目录的 `COMFYUI_REMOTE_SETUP.md`。
