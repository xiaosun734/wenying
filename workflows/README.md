# ComfyUI 工作流目录

把在远程 ComfyUI 页面通过 `Workflow -> Save (API Format)` 导出的 JSON 放到这里。

## 当前启用的工作流

| 环节 | 工作流 | manifest | 模型 |
|---|---|---|---|
| 视频（图生视频） | `video_wan2_2_5b_i2v_api.json` | `manifests/wan22-5b-i2v.json` | Wan 2.2 TI2V 5B |
| 人物视图 / 场景母版（文生图） | `z-image-turbo-t2i-api.json` | `manifests/z-image-turbo-t2i.json` | Z-Image Turbo |
| 关键帧（单图图生图） | `krea2-keyframe-img2img-api.json` | `manifests/krea2-keyframe-img2img.json` | Krea2-Turbo Realistic v3 |
| 关键帧（多图参考编辑） | `qwen-image-edit-keyframe-api.json` | `manifests/qwen-image-edit-keyframe.json` | Qwen-Image-Edit-2509 |

对应 `.env` 变量：`COMFYUI_WORKFLOW_PATH` / `COMFYUI_IMAGE_WORKFLOW_PATH` / `COMFYUI_KEYFRAME_WORKFLOW_PATH`，以及同名的 `*_MANIFEST_PATH`。

## 未启用的文件

以下文件当前没有被 `.env` 引用，保留作备选：

- `krea2-turbo-t2i-api.json` + `manifests/krea2-turbo-t2i.json`：Krea2 的文生图版本，与 Z-Image 结构一致，可以整体替换图像工作流。
- `sunn 9.9文生图.json`：早期导入的第三方文生图工作流，没有对应 manifest。

## 关键帧：单图 img2img 还是多图参考

`krea2-keyframe-img2img-api.json` 是单图 img2img：`LoadImage → VAEEncode → KSampler`，只能接收一张参考图。镜头同时锁定了角色和场景参考图时，服务只会把主参考图（有可见主体的镜头优先角色三视图）交给模型，场景只存在于提示词文字里。

后果很直观：模型一边要“保持这张设定图”，一边要“画出文字里的场景”，常见的折中产物就是上下拼贴、多格排版，景别也不听分镜——因为 img2img 的构图完全继承 init 图。

`qwen-image-edit-keyframe-api.json` 用的是 Qwen-Image-Edit 的多图编辑节点 `TextEncodeQwenImageEditPlus`（image1 / image2 两个参考输入），配合 manifest 里的 `referenceImages` 声明，可以把角色参考图和场景母版一起送进模型：

```json
"startImage":      { "node": "10", "field": "image" },
"referenceImages": [{ "node": "11", "field": "image" }],
```

任务层会按“主参考 + 补充参考（场景 → 角色 → 道具，各一张）”的顺序传图，并在提示词前补一句“把这个角色自然地放进该场景”的合成指令；单图工作流不声明 `referenceImages`，补充参考图会被自动跳过。

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
