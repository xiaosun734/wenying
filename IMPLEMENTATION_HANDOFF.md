# 解说文案改写实施交接记录

> 2026-09-14 已完成三层前期策划与 RAG 改造。最新架构、数据迁移、接口、测试和下一阶段计划统一记录在 `三层分镜与RAG架构实施记录.md`；本文后面的多镜头 v4 内容仅作为历史记录。

更新时间：2026-09-07

## 已完成

- 新增 `server/db.mjs`：Node 24 `node:sqlite` 数据库初始化、项目、任务、文案版本、片段、事务、草稿 revision 和任务恢复查询。
- 新增 `server/safety.mjs`：输入/输出清洗、基础敏感词审核。
- 新增 `server/providers/openai-compatible.mjs`：DeepSeek/OpenAI 兼容 Chat Completions Provider、固定 `rewrite-v1` Prompt、Mock Provider、重试和结构化结果校验。
- 新增 `server/rewrite-task.mjs`：单并发任务队列、任务状态更新、失败处理、手动重试、服务重启恢复。
- 新增 `server/api.mjs`：项目、改写任务、任务状态、重试、版本、片段、草稿保存、确认文案 API。
- 已替换 `server.mjs`：同源 API + 静态文件服务、`.env` 加载、数据库初始化、任务恢复、优雅退出。
- 已更新 `package.json`：Node >= 24、`node --test` 脚本。
- 已新增 `.env.example` 和 `.gitignore`。
- 已完成 `app.js` 改造：加入 API 请求封装、session 项目 ID、服务端状态字段、任务轮询/恢复、真实提交入口、处理失败/重试 UI、结构化片段映射、800ms 草稿自动保存/确认函数、动态文案预览和输入边界校验。
- 已补充 `README.md` 启动和接口说明、`test/rewrite-api.test.mjs` API 回归测试、SQLite 原文过期清理和不可变版本保护。

## 暂停位置

实现已完成，当前记录用于后续维护。服务端和前端文件均已通过 `node --check`，`pnpm test` 通过 3 个回归测试。

## 视频生成模块进度（2026-09-08）

- 已新增作品级/片段级视频生成任务、任务恢复、重试和取消状态。
- 已新增片段版本、音频/字幕/视频/BGM/导出素材记录。
- 已接入 `MockMediaProvider`，本地可完整跑通配音、字幕、画面、BGM 和素材状态流转。
- 已接入单段重生成，成功后切换 `active_version_id`，失败时保留旧版本。
- 已接入 Mock 导出任务，支持比例、分辨率、导出进度和导出记录。
- 前端生成页已从本地模拟计时器切换为任务 API 轮询，支持刷新恢复、失败重试和片段状态展示。
- 编辑器已接入片段提示词、配音音色和单段重生成参数。
- `test/rewrite-api.test.mjs` 已增加视频任务、素材版本、单段重生成和导出任务回归测试。

当前媒体 Provider 仍为 Mock：只生成可追踪的对象 Key 和数据库素材记录，不会创建真实视频文件。下一步接入真实 TTS、文生视频 Provider 和 FFmpeg Render Worker 时，保持现有任务/API/数据结构不变，替换 Provider 与 Runner 实现即可。

## 多镜头改造进度（2026-09-10）
- 数据库 schema 升级到 v4，新增 `segment_shots` 和 `media_assets.shot_id`。
- 新增中文分镜生成、`/projects/:id/storyboard-tasks` 与 `/shots/:id/prompt` 接口；视频模型直接使用中文镜头提示词。
- 片段任务现按“配音 → 分镜 → 单镜头视频 → 片段合成”执行，最终片段仍写入 `type=video` 以兼容导出。
- 新增 Mock/FFmpeg Composer 与可选豆包 TTS Provider；默认配置仍为 Mock。
- 前端新增中文镜头审核页和编辑器镜头提示词列表。

## 继续时的优先顺序

1. 配置真实 `LLM_API_KEY` 后验证 DeepSeek 返回质量。
2. 如需上线，补充真实用户鉴权、专业内容审核服务和多实例队列。

## 已知风险/注意事项

- 当前前端仍保留原始 demo `segments`，真实任务成功后才会被 API 结果替换；没有 active project 时工作台仍显示 demo 数据，这是预期的兼容状态。
- 当前未引入第三方依赖；SQLite 使用 Node 24 实验性内置模块。
- 默认 Provider 是 DeepSeek，未配置 `LLM_API_KEY` 时任务会进入失败状态，不会静默使用 Mock；本地演示需显式设置 `LLM_PROVIDER=mock`。
- 已使用 Mock Provider 完成服务启动、静态文件、任务、草稿、确认和不可变版本 smoke test；真实 DeepSeek 需要用户提供 API Key。
