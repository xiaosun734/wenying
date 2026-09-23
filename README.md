# 文影单机 MVP

## 启动

需要 Node.js 24 或更高版本。

1. 复制 `.env.example` 为 `.env`。
2. 设置 `LLM_API_KEY`，默认使用 DeepSeek；本地无密钥演示可显式设置 `LLM_PROVIDER=deepseek`。
3. 执行 `pnpm dev`，打开 `http://127.0.0.1:4173`。

SQLite 数据默认写入 `data/wenying.sqlite`。数据目录和密钥文件不会提交到仓库。

视频生成默认使用 `MEDIA_PROVIDER=comfyui`，用于本地完整验证任务、片段版本、素材状态和导出状态；接入真实 TTS、文生视频和 FFmpeg 服务时替换对应 Provider/Runner。

三层前期策划流水线：确认文案并选择视觉配置后，通过异步任务依次完成“导演分析 → RAG 知识检索 → 镜头选择 → 结构化分镜表”。分镜确认后，视频模型才会按镜头生成素材，再由 Composer 合成为带口播音轨的片段视频。内置知识库位于 `knowledge/`，覆盖镜头语言、构图、运镜焦段、转场和模型能力。默认 `COMPOSER_PROVIDER=ffmpeg`；配置 `COMPOSER_PROVIDER=ffmpeg` 和 `FFMPEG_PATH` 可启用本地 FFmpeg 合成及 `dissolve/fade` 转场。豆包 TTS 通过 `TTS_PROVIDER=doubao` 及 `DOUBAO_TTS_*` 环境变量启用。

创建作品时可填写可选的“背景设定”（最多 2,000 字），用于补充世界观、人物关系和前情。它会随项目保存，并注入到文案改写、视觉设定、导演分析、镜头选择、分镜和单镜头提示词六个环节，作为全片一致性的锚点。背景设定与原文共享 24 小时留存策略（`SOURCE_RETENTION_HOURS`），原文清理时会一并清空。

AI 提示词按功能拆分在 `prompts/` 下，每个提示词变量对应一个独立文件，例如 `prompts/director/system.txt`、`prompts/director/user.txt`、`prompts/visual-bible/system.txt` 和 `prompts/video/negative.txt`。完整映射见 [prompts/README.md](./prompts/README.md)。模板支持 `{genre}`、`{sourceText}`、`{background}` 等占位符；修改后需要重启服务。`PROMPTS_DIR` 可以替换整个提示词目录，同名环境变量仍可临时覆盖单个提示词。

角色、场景和道具的已选参考图，以及每个镜头已选中的关键帧，都支持输入调整提示词后生成新的图生图候选。该能力复用 `COMFYUI_KEYFRAME_WORKFLOW_PATH` / `COMFYUI_KEYFRAME_WORKFLOW_MANIFEST_PATH` 配置，原图和原候选会保留，新结果确认前不会替换当前锁定资产。

关键帧生产默认使用两阶段流程：策划阶段输出主体锚点、机位编号、摄影机位置、朝向和高度；先生成不含主要角色的镜头背景板；审核确认背景板后，再以背景板为画布加入角色。背景板使用 `COMFYUI_SCENE_PLATE_WORKFLOW_PATH` / `COMFYUI_SCENE_PLATE_WORKFLOW_MANIFEST_PATH` 配置的独立空 latent 工作流，不再直接把场景母版图当最终关键帧画布。`SCENE_PLATE_REQUIRED=auto` 时，配置了场景背景板工作流就强制走该流程。

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
- `POST /shots/:id/scene-plate-tasks` 按策划机位生成无角色的镜头背景板
- `POST /media-assets/:id/edit-tasks` 按提示词调整已选参考图或关键帧并生成新候选
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

## 准确性验收

```bash
pnpm verify
```

只读检查参考资产 → 关键帧 → 图生视频 → 字幕/文字叠加 → 合成这条链路是否真正闭环（关键帧是否消费参考图、视频是否消费首帧、字幕是否烧录、时长是否与 TTS 对齐等），并列出必须人工确认的画面项。完整操作步骤见 [准确性验收指南.md](./准确性验收指南.md)。

## Database Admin

Open `http://127.0.0.1:4173/admin` after starting the service to view and edit projects, segments, shots, media assets, tasks, and knowledge tables in SQLite. The admin page supports pagination, search, JSON field editing, and record deletion.

The database file is `data/wenying.sqlite`. The admin endpoint is bound to localhost; stop the service and back up the database before direct edits.
