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

## 6. 常见错误

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

## 7. 重要边界

`COMFYUI_OUTPUT_DIR` 不需要配置。远程服务器的 output 目录对本地 Node 进程不可见，项目通过 ComfyUI 的 `/view` 接口下载结果，因此不要填写远程机器上的磁盘路径。

当前接入的是“真实画面 + Mock 音频/字幕/BGM”版本。ComfyUI 负责视频画面；配音、字幕和 BGM 仍沿用现有 Mock Provider，后续再分别接入 TTS、字幕和 FFmpeg 合成。
