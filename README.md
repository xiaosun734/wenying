# 文影单机 MVP

## 启动

需要 Node.js 24 或更高版本。

1. 复制 `.env.example` 为 `.env`。
2. 设置 `LLM_API_KEY`，默认使用 DeepSeek；本地无密钥演示可显式设置 `LLM_PROVIDER=deepseek`。
3. 执行 `pnpm dev`，打开 `http://127.0.0.1:4173`。

SQLite 数据默认写入 `data/wenying.sqlite`。数据目录和密钥文件不会提交到仓库。

视频生成默认使用 `MEDIA_PROVIDER=comfyui`，用于本地完整验证任务、片段版本、素材状态和导出状态；接入真实 TTS、文生视频和 FFmpeg 服务时替换对应 Provider/Runner。

三层前期策划流水线：确认文案并选择视觉配置后，通过异步任务依次完成“导演分析 → RAG 知识检索 → 镜头选择 → 结构化分镜表”。分镜确认后，视频模型才会按镜头生成素材，再由 Composer 合成为带口播音轨的片段视频。内置知识库位于 `knowledge/`，覆盖镜头语言、构图、运镜焦段、转场和模型能力。默认 `COMPOSER_PROVIDER=ffmpeg`；配置 `COMPOSER_PROVIDER=ffmpeg` 和 `FFMPEG_PATH` 可启用本地 FFmpeg 合成及 `dissolve/fade` 转场。豆包 TTS 通过 `TTS_PROVIDER=doubao` 及 `DOUBAO_TTS_*` 环境变量启用。

AI 提示词集中在 `.env`：`LLM_*_SYSTEM_PROMPT` 控制系统提示词，`LLM_*_USER_PROMPT_TEMPLATE` 控制传给大语言模型的上下文模板，`VIDEO_*_PROMPT_TEMPLATE` 控制视频提示词模板，`COMFYUI_NEGATIVE_PROMPT` 控制 ComfyUI 负面提示词。模板支持 `{genre}`、`{sourceText}` 等占位符，换行使用 `\\n` 表示；修改后需要重启服务。

## 文案接口

前端使用同源 `/api/v1` 接口：

- `POST /projects` 创建作品
- `POST /projects/:id/script-tasks` 创建改写任务
- `GET /script-tasks/:id` 查询任务进度
- `POST /script-tasks/:id/retry` 重试失败任务
- `GET /projects/:id` 恢复作品、任务和片段
- `PATCH /segments/:id/draft` 保存片段草稿
- `POST /projects/:id/script/confirm` 创建不可变文案版本

改写任务采用 HTTP 轮询，服务重启后会恢复未完成任务。文案改写不扣视频生成额度。

## 视频生成接口

- `POST /projects/:id/generation-tasks` 创建作品级视频任务
- `POST /projects/:id/storyboard-tasks` 创建异步三层前期策划任务
- `GET /storyboard-tasks/:id` 查询策划进度
- `GET /storyboard-plans/:id` 查看策划版本
- `GET /storyboard-plans/:id/retrievals` 查看 RAG 召回依据
- `PATCH /storyboard-plans/:id/director-analysis` 修改导演分析
- `PATCH /storyboard-plans/:id/shot-selection` 修改镜头选择
- `POST /storyboard-plans/:id/regenerate` 从指定层创建派生版本
- `POST /storyboard-plans/:id/confirm` 锁定策划版本
- `PATCH /shots/:id` 修改结构化分镜字段并使旧镜头素材失效
- `GET /generation-tasks/:id` 查询生成进度和片段素材
- `POST /generation-tasks/:id/retry` 重试生成任务
- `POST /generation-tasks/:id/cancel` 取消生成任务
- `POST /segments/:id/regenerate` 创建单段新版本并重新生成
- `POST /projects/:id/export-tasks` 创建导出任务
- `GET /export-tasks/:id` 查询导出进度
- `GET /projects/:id/exports` 查看导出记录

Task polling resumes pending/running work after restart. Video generation requires a confirmed storyboard; if a real provider is not configured, the task fails explicitly instead of creating placeholder media.

详细架构、迁移和后续计划参见 [三层分镜与RAG架构实施记录.md](./三层分镜与RAG架构实施记录.md)。

## 检查

```bash
pnpm test
```

## Database Admin

Open `http://127.0.0.1:4173/admin` after starting the service to view and edit projects, segments, shots, media assets, tasks, and knowledge tables in SQLite. The admin page supports pagination, search, JSON field editing, and record deletion.

The database file is `data/wenying.sqlite`. The admin endpoint is bound to localhost; stop the service and back up the database before direct edits.
