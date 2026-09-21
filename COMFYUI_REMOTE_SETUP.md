# 远程 ComfyUI 配置

当前项目采用“项目后端连接 ComfyUI”的方式：浏览器只访问本项目，Node 服务负责向远程 ComfyUI 提交工作流、轮询任务、下载 MP4 并保存到本地 `data/media`。

## 1. 从 ComfyUI 导出工作流

在远程 ComfyUI 页面中打开已经手动跑通的工作流，然后选择：

```text
Workflow -> Save (API Format)
```

把导出的 JSON 放到项目目录：

```text
workflows/video_wan2_2_5b_i2v_api.json
```

这里必须是 **API Format**，不能直接把普通的 `Save` 工作流 JSON 放进来。普通工作流通常包含 `nodes` 和画布信息，而后端提交 `/prompt` 需要的是节点 ID 到节点配置的映射。

ComfyUI 的负面提示词通过 `.env` 中的 `COMFYUI_NEGATIVE_PROMPT` 配置，服务会把它写入工作流可识别的负向 `CLIPTextEncode` 节点。

三个环节（视频 / 图像 / 关键帧）各自需要一份 manifest，用来声明提示词、seed、尺寸、首帧、帧率和 denoise 写在哪个节点上：

```text
workflows/manifests/wan22-5b-i2v.json            配合 video_wan2_2_5b_i2v_api.json（i2v）
workflows/manifests/z-image-turbo-t2i.json       配合 z-image-turbo-t2i-api.json（t2i）
workflows/manifests/krea2-keyframe-img2img.json  配合 krea2-keyframe-img2img-api.json（i2i）
```

换了工作流就必须换对应的 manifest：manifest 的节点编号是跟着具体工作流走的。服务启动时会自动核对每一组“工作流 + manifest”的形态是否一致，配对错误会打印 `工作流配置有误：...`，生成时会抛出 `WORKFLOW_MANIFEST_MODE_MISMATCH` / `WORKFLOW_MANIFEST_NODE_MISSING`。

## 2. 配置项目本地 `.env`

从 `.env.example` 复制配置，至少改下面几项：

```env
MEDIA_PROVIDER=comfyui
MEDIA_OUTPUT_DIR=./data/media

# 例：浏览器打开的 ComfyUI 根地址
COMFYUI_BASE_URL=https://comfy.example.com

# 这是项目本地路径，不是远程 ComfyUI 服务器的路径
COMFYUI_WORKFLOW_PATH=./workflows/video_wan2_2_5b_i2v_api.json

COMFYUI_TIMEOUT_MS=900000
COMFYUI_POLL_MS=1000
COMFYUI_WIDTH=576
COMFYUI_HEIGHT=1024
COMFYUI_FRAMES=121
COMFYUI_FPS=24
COMFYUI_FIXED_SEED=
```

如果你的网页地址带部署前缀，例如：

```text
https://example.com/comfyui/
```

就填写：

```env
COMFYUI_BASE_URL=https://example.com/comfyui
```

不要再额外拼 `/prompt`；代码会自动请求 `/prompt`、`/history/:prompt_id` 和 `/view`。

## 3. 配置鉴权

无登录、仅内网访问的 ComfyUI，三个配置都留空即可。

如果反向代理使用 Bearer Token：

```env
COMFYUI_AUTH_TOKEN=你的token
```

如果服务使用 `X-API-Key`：

```env
COMFYUI_API_KEY=你的api-key
```

如果服务使用 HTTP Basic Auth：

```env
COMFYUI_BASIC_AUTH=用户名:密码
```

不要把真实密钥写入 `.env.example`，也不要提交 `.env`。当前仓库已经在 `.gitignore` 中忽略 `.env`。

## 4. 首帧图片的限制

当前数据库还没有“每个片段的首帧图片上传”字段。若工作流使用 `LoadImage`，第一版可以用同一张默认首帧：

```env
COMFYUI_INPUT_IMAGE_PATH=./data/reference/primary-character.png
```

这张图片由 Node 服务上传到远程 ComfyUI 的 input 目录，并替换 API 工作流中的 `LoadImage.image`。图片文件必须存在于运行 Node 服务的这台机器上，不是远程 ComfyUI 机器上的路径。

如果暂时不配置首帧，请使用纯文生视频工作流，或者在 API 工作流里保留不依赖图片输入的路径。

## 5. 启动与验证

修改 `.env` 后必须重启 Node 服务：

```powershell
pnpm dev
```

启动日志中应该看到：

```text
媒体 Provider：comfyui/comfyui-workflow
```

然后在项目中确认文案并点击生成视频。任务流程是：

```text
项目 -> Node -> 远程 ComfyUI /prompt
             -> 轮询 /history/:prompt_id
             -> 下载 /view
             -> data/media/projects/.../video.mp4
             -> 前端播放 /media/projects/.../video.mp4
```

## 6. 关键帧的多图参考模式（Qwen-Image-Edit-2509）

默认的关键帧工作流是单图 img2img（Krea2），它只能接收**一张**参考图。镜头同时有角色和场景参考图时，服务只会把主参考图（有可见主体的镜头优先角色三视图）交给模型，场景只以文字形式出现在提示词里。模型为了同时满足“保持这张设定图”和“画出提示词里的场景”，往往会交出一张上下拼贴的画面，景别也听不进分镜表。

多图参考模式改用 Qwen-Image-Edit-2509 的图像编辑节点 `TextEncodeQwenImageEditPlus`（支持 image1 / image2 / image3 三个参考输入），把角色参考图和场景母版一起送进模型，并在提示词前面补一句“把这个角色自然地放进该场景”的合成指令。

### 需要的模型文件

| 文件 | 放到远程 ComfyUI 的目录 | 说明 |
| --- | --- | --- |
| `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `models/diffusion_models/` | Qwen-Image-Edit-2509 主模型（Comfy-Org 打包的 fp8 权重） |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `models/text_encoders/` | Qwen2.5-VL-7B 文本编码器 |
| `qwen_image_vae.safetensors` | `models/vae/` | 该机已有，无需重复下载 |

### 切换步骤

1. 下载模型并放到上面的目录。
2. 自检（会校验工作流 / manifest 配对，并逐个检查模型文件是否存在）：

   ```bash
   npm run check:keyframe-edit
   ```

   全部 `✓` 之后再切换。
3. 修改 `.env`：

   ```env
   COMFYUI_KEYFRAME_WORKFLOW_PATH=./workflows/qwen-image-edit-keyframe-api.json
   COMFYUI_KEYFRAME_WORKFLOW_MANIFEST_PATH=./workflows/manifests/qwen-image-edit-keyframe.json
   COMFYUI_KEYFRAME_DENOISE=1
   ```

   `denoise` 必须是 1：编辑工作流从空 latent 起采样，参考图通过条件注入；旧的 img2img 工作流才用 0.82。
4. 重启服务，日志出现下面这行即生效：

   ```text
   ComfyUI keyframe 工作流：i2i / qwen-image-edit-keyframe
   ```

想回到单图 img2img，把上面三行换回 `krea2-keyframe-img2img-api.json` / `krea2-keyframe-img2img.json` / `COMFYUI_KEYFRAME_DENOISE=0.82` 即可。

### 参考图是怎么选的

- 主参考（`startImage`）：有可见主体时优先角色参考图，否则用场景母版。
- 补充参考（`referenceImages`）：再按“场景 → 角色 → 道具”各取一张，最多两张。

单图工作流不会声明 `referenceImages`，补充参考图会被自动跳过（既不上传也不进工作流）。

## 7. 常见错误

| 错误 | 检查位置 |
| --- | --- |
| `COMFYUI_UNREACHABLE` | Node 所在机器是否能访问 `COMFYUI_BASE_URL`；不要只检查自己的浏览器 |
| `COMFYUI_HTTP_ERROR 401/403` | 检查三种鉴权配置，或检查反向代理是否允许 Node 服务器访问 |
| `COMFYUI_WORKFLOW_NOT_FOUND` | `COMFYUI_WORKFLOW_PATH` 是本地项目路径，确认文件存在 |
| `COMFYUI_WORKFLOW_INVALID` | 重新导出 `Save (API Format)`，不要使用普通工作流 JSON |
| `COMFYUI_WORKFLOW_MISSING_PROMPT` | 工作流中缺少可识别的 `CLIPTextEncode` 正向提示词节点 |
| `COMFYUI_UPLOAD_FAILED` | 检查远程 ComfyUI 是否允许 `/upload/image`，以及本地首帧文件是否存在 |
| `COMFYUI_TIMEOUT` | 先在远程 ComfyUI 页面手动跑一次；降低分辨率、帧数或提高超时时间 |
| 任务成功但播放器空白 | 检查 Node 的 `data/media` 是否生成 MP4，以及浏览器访问 `/media/...` 是否返回 200 |

## 8. 重要边界

`COMFYUI_OUTPUT_DIR` 不需要配置。远程服务器的 output 目录对本地 Node 进程不可见，项目通过 ComfyUI 的 `/view` 接口下载结果，因此不要填写远程机器上的磁盘路径。

当前接入的是“真实画面 + Mock 音频/字幕/BGM”版本。ComfyUI 负责视频画面；配音、字幕和 BGM 仍沿用现有 Mock Provider，后续再分别接入 TTS、字幕和 FFmpeg 合成。
