# 三层分镜与 RAG 架构实施记录

更新时间：2026-09-14  
数据库版本：v5  
实现状态：已完成可运行的单机 MVP 纵向链路

## 1. 本次目标

把原来的“文案直接生成中文镜头提示词”升级为三个职责独立的策划层：

```text
确认后的剧情/解说文案
        ↓
导演分析层
        ↓
剧情节拍 / 情绪 / 动作 / 场景 / 叙事目的
        ↓
RAG 知识检索增强
        ↓
镜头选择层
        ↓
景别 / 角度 / 运动 / 焦段 / 构图 / 选择理由
        ↓
分镜层
        ↓
镜头 / 剧情 / 景别 / 运动 / 角度 / 目的 / 焦段 / 时长
        ↓
用户确认不可变策划版本
        ↓
逐镜头视频生成 → 转场与片段合成 → 导出
```

RAG 的职责是为镜头选择提供少量、可引用的摄影与剪辑知识证据，而不是取代导演分析或直接扩写视频提示词。

## 2. 已完成内容

### 2.1 三层模型调用

在 `server/providers/openai-compatible.mjs` 中新增：

- `generateDirectorAnalysis()`：只输出剧情节拍、情绪、动作、场景、叙事目的和连续性约束。
- `generateShotSelection()`：结合导演分析、视觉设定、生成配置和 RAG 证据选择镜头语言。
- `generateStoryboard()`：把上游已确定的决策组装成最终分镜表，不重新改写导演意图。
- Mock Provider 的对应实现，保证无外部 API 时仍可跑通完整流程。
- `director-analysis-v1`、`shot-selection-rag-v1`、`storyboard-v1` 三个提示词版本。

同时修复了旧 `requestStructured()` 的真实调用问题。旧实现先把响应解析成改写结果，随后又尝试从结果读取 `choices`，可能使真实模型的视觉设定和分镜 JSON 退化为空对象。现在底层请求只返回原始 Provider payload，文案和结构化任务分别解析。

### 2.2 RAG 知识检索

新增 `server/knowledge-retriever.mjs`，提供统一的 `KnowledgeRetriever` 接口。

当前检索策略为 `hybrid-tags-text-v1`：

1. 按最小时长、最大时长、主体数量等约束做硬过滤。
2. 使用情绪、动作、场景、叙事目的、题材和模型等结构化标签匹配。
3. 使用中文二元字符相似度进行轻量文本重排。
4. 合并知识条目优先级，返回每个剧情节拍的 Top 6 证据。
5. 将查询、结果、知识库版本和策略版本写入数据库。

当前没有伪装成“向量 RAG”：MVP 尚未调用 Embedding API，也没有引入向量数据库。检索器接口已经隔离，下一阶段可以替换内部实现而不修改导演、镜头选择和分镜任务。

新增五个首批知识库：

| 文件 | 知识库 | 当前条目数 |
|---|---|---:|
| `knowledge/camera-language.json` | 镜头语言 | 5 |
| `knowledge/composition.json` | 构图技巧 | 5 |
| `knowledge/movement-and-lens.json` | 运镜与焦段 | 5 |
| `knowledge/transitions.json` | 剪辑与转场 | 5 |
| `knowledge/model-capabilities.json` | 视频模型能力 | 3 |

知识条目包含 `id`、标题、正文、标签、适用约束、来源和优先级。镜头选择必须返回真实召回结果里的 `evidenceIds`，服务端会拒绝虚构的知识 ID。

### 2.3 异步策划任务

新增 `server/storyboard-task.mjs`，任务状态为：

```text
queued
→ preparing
→ building_visual_bible
→ analyzing_direction
→ retrieving_knowledge
→ selecting_shots
→ building_storyboard
→ review_ready
```

任务支持：

- 幂等创建。
- HTTP 轮询。
- 失败重试。
- 服务重启恢复 `pending/running` 任务。
- 从 `director`、`camera` 或 `storyboard` 任一层创建派生重生成版本。
- 下游重生成时复用已确认的上游产物。
- 每个视频任务锁定具体的 `storyboardPlanId`。

旧接口虽返回 HTTP 202，但会在单个请求中同步调用整个作品的 LLM。现在它会立即返回策划任务，计算在 Runner 中执行。

### 2.4 数据库 v5

新增表：

- `storyboard_plans`：策划版本、三层结构化结果、配置、知识快照和提示词版本。
- `storyboard_tasks`：异步策划任务。
- `knowledge_bases`：知识库及版本。
- `knowledge_items`：结构化知识条目。
- `retrieval_runs`：逐剧情节拍的检索查询与召回结果。
- `shot_transitions`：两个相邻镜头之间的转场关系。

扩展字段：

- `projects.active_storyboard_plan_id`
- `segment_versions.storyboard_plan_id`
- `segment_shots.storyboard_plan_id`
- `segment_shots.beat_id`
- `segment_shots.plot_text`
- `segment_shots.shot_size`
- `segment_shots.camera_movement`
- `segment_shots.camera_angle`
- `segment_shots.focal_length_mm`
- `segment_shots.composition`
- `segment_shots.narrative_purpose`
- `segment_shots.selection_reason`
- `segment_shots.evidence_ids_json`

迁移采用新表创建和逐字段 `ALTER TABLE`，现有 v4 SQLite 数据与媒体目录不会被删除。

### 2.5 分镜和视频提示词

最终中文视频提示词不再让 LLM 自由扩写，而由 `compileVideoPrompt()` 确定性编译：

```text
剧情
；景别、角度、构图
；焦段、镜头运动
；叙事目的
；视觉设定
；单主体、单动作、无字幕、无镜头切换约束
```

这样可以保证结构化分镜表和实际提交给视频模型的内容一致。

编辑剧情、景别、运动、角度、构图、目的或焦段时：

1. 更新结构化分镜字段。
2. 重新编译 `promptZh`。
3. 将旧 `shot_video` 素材标记为 `stale`。
4. 后续生成不会复用已经过期的镜头素材。

已确认的策划计划不可原地修改，必须创建派生版本。

### 2.6 转场执行

转场被建模为相邻镜头之间的关系，而不是单个镜头字段：

- `cut`：Composer 硬切。
- `match_cut`：通过镜头内容和硬切完成动作或图形匹配。
- `dissolve`：FFmpeg `xfade=fade`。
- `fade`：FFmpeg `xfade=fadeblack`。

`MockComposer` 会记录转场摘要；`FfmpegComposer` 只有在存在需要渲染的转场时才使用 filter graph，否则保留更简单的 concat 流程。

### 2.7 API

新增或升级接口：

| 方法与路径 | 作用 |
|---|---|
| `POST /projects/:id/storyboard-tasks` | 创建异步三层策划任务 |
| `GET /storyboard-tasks/:id` | 查询策划进度与项目状态 |
| `POST /storyboard-tasks/:id/retry` | 重试失败任务 |
| `GET /storyboard-plans/:id` | 获取策划版本 |
| `GET /storyboard-plans/:id/retrievals` | 查看 RAG 查询和证据 |
| `PATCH /storyboard-plans/:id/director-analysis` | 更新导演分析草稿 |
| `PATCH /storyboard-plans/:id/shot-selection` | 更新镜头选择草稿 |
| `POST /storyboard-plans/:id/regenerate` | 从指定层创建派生版本 |
| `POST /storyboard-plans/:id/confirm` | 确认并锁定策划版本 |
| `PATCH /shots/:id` | 更新结构化分镜字段 |

`POST /projects/:id/generation-tasks` 现在增加门禁：当前文案版本必须存在一个已确认的策划版本，否则返回 `STORYBOARD_NOT_CONFIRMED`。

### 2.8 前端

顶层流程调整为：

```text
输入内容 → 文案预览 → 生成配置 → 前期策划 → 视频生成 → 视频编辑
```

完成的页面能力：

- 配置页前置到策划之前，画面风格、配音和画幅会参与策划。
- 独立的策划任务进度页，显示导演分析、知识检索、镜头选择和分镜编排阶段。
- 三个审核标签：导演分析、镜头选择、分镜表。
- 镜头选择页展示选择理由和 RAG `evidenceIds`。
- 分镜表包含镜头、剧情、景别、运动、角度、目的和焦段，并支持结构化编辑。
- 支持从当前标签对应的层重新生成。
- 确认分镜后自动进入视频生成。
- 分镜表在小屏幕使用横向滚动，避免固定列被压缩。

## 3. 当前系统架构

```text
Browser / app.js
  ├─ 文案编辑与确认
  ├─ 视觉/声音/画幅配置
  ├─ 策划任务轮询与三层审核
  ├─ 分镜表编辑
  └─ 视频任务、编辑器与导出
           │ HTTP /api/v1
           ▼
server.mjs
  ├─ RewriteTaskRunner
  │    └─ TextProvider.rewrite
  ├─ StoryboardTaskRunner
  │    ├─ TextProvider.generateVisualBible
  │    ├─ TextProvider.generateDirectorAnalysis
  │    ├─ KnowledgeRetriever
  │    ├─ TextProvider.generateShotSelection
  │    ├─ TextProvider.generateStoryboard
  │    └─ VideoPromptCompiler
  ├─ MediaTaskRunner
  │    ├─ TTS Provider
  │    ├─ Media Provider / ComfyUI（逐镜头）
  │    └─ Composer / FFmpeg（片段及转场）
  ├─ ExportTaskRunner
  └─ SQLite v5
       ├─ 文案、片段与版本
       ├─ 策划计划与任务
       ├─ 知识库与检索记录
       ├─ 镜头与转场
       └─ 媒体、视频任务与导出
```

核心版本关系：

```text
Project
  └─ active_script_version_id
       └─ StoryboardPlan v1（可确认、不可变）
            ├─ DirectorAnalysis
            ├─ RetrievalRuns
            ├─ ShotSelection
            ├─ SegmentVersion × N
            │    └─ SegmentShot × N
            └─ ShotTransition × N

StoryboardPlan v1
  └─ 从 camera 层重生成
       └─ StoryboardPlan v2（base_plan_id = v1）
```

## 4. 当前边界与已知事项

1. 当前知识库只有 23 条种子规则，用于验证架构、检索引用和生成门禁，不代表完整摄影教材。
2. 当前 RAG 是标签过滤与文本相似度混合检索，尚未接 Embedding、向量数据库或 Cross-Encoder reranker。
3. 导演分析和镜头选择在前端以审核展示为主；后端已有完整结构更新接口，但前端尚未提供逐字段表单编辑。
4. 当前分镜数量仍以片段预计口播时长约每 5 秒一个节拍作为目标数量。导演负责节拍内容，但尚未自由决定镜头增删。
5. 分镜表尚未提供新增、删除和拖动排序镜头的 UI/API。
6. 视觉设定改变后的分层失效仍以“创建新的策划任务”处理，尚未提供差异化局部失效按钮。
7. 转场只在片段内部由 Composer 实际使用；跨片段转场已经存储，但项目级最终导出尚未消费该关系。
8. 真实 LLM 依赖 `.env` 中六个三层提示词配置。Mock 模式已完整验证，真实 DeepSeek 的输出质量仍需使用有效 API Key 做样本评估。
9. FFmpeg `xfade` 路径已实现，但自动化测试当前使用 Mock Composer，没有运行真实 FFmpeg 媒体集成测试。
10. 项目目录当前不是 Git 仓库，无法提供 commit 或 diff 状态；修改直接落在共享工作区。

## 5. 下一阶段计划

### P0：真实质量与编辑闭环

1. 使用同一批 20～30 个小说片段跑真实 DeepSeek/兼容模型。
2. 为三个结构化输出增加一次 JSON 修复重试，并记录 Token、耗时和错误原因。
3. 给导演分析和镜头选择增加逐字段编辑 UI，而不是只提供查看和后端 PATCH。
4. 增加镜头的新增、删除、复制和排序，并同步修复 transition 链。
5. 先生成真实 TTS 或获取时间戳，再对镜头时长做确定性校准。
6. 增加分镜确认前检查：总时长、轴线、人物/服装连续性、镜头运动冲突和重复构图。

### P1：真正的向量 RAG

1. 新增独立 `EmbeddingProvider`，配置嵌入模型、维度和批处理。
2. 为知识条目生成内容哈希和向量，内容未变化时不重复嵌入。
3. 小规模先接 `sqlite-vec`；需要多实例或十万级条目时迁移到 Qdrant/pgvector。
4. 检索改为 BM25/标签过滤 + 向量召回 + reranker。
5. 依然保留硬约束过滤和知识 ID 引用校验。
6. 建立知识库管理页：导入、版本、启停、来源、审核和回滚。

### P1：转场和最终合成

1. 为 `FfmpegComposer` 增加真实视频夹具集成测试。
2. 处理 `xfade` 带来的总时长重叠，并同步字幕与配音时间轴。
3. 让项目级 Export Runner 消费跨片段 transition。
4. 在审核页增加前后镜头和转场关系可视化。
5. 区分 Composer 转场与需要视频模型生成的遮挡、甩镜等镜内过渡。

### P2：评估与运营

1. 建立固定评估集，比较无 RAG、当前轻量 RAG、向量混合 RAG。
2. 指标包括：剧情忠实度、镜头可执行性、连续性、知识命中率、无效运镜率、人工修改率和生成成功率。
3. 记录用户采纳/修改的知识建议，用于调整条目优先级，但不直接把用户内容写回公共知识库。
4. 增加成本预算、并发限制、缓存和分层超时策略。

## 6. 验证记录

执行：

```bash
pnpm test
```

结果：11 个测试全部通过。

覆盖范围：

- ComfyUI 逐镜头提交和下载。
- OpenAI-compatible 结构化响应解析。
- OpenAI-compatible 网关的 `json_object` 小写 `json` 兼容。
- 结构化请求对网络、429 和 5xx 的退避重试。
- 文案任务、幂等、短文本和版本确认。
- 单片段单镜头。
- 三层策划、RAG 引用、结构化分镜字段。
- 视频生成前的策划确认门禁。
- 已确认分镜不可原地修改。
- 从下游层创建派生策划版本并保留上游结果。
- 镜头选择失败后复用已完成导演分析的断点重试。
- 作品级视频生成、素材、单段重生成和导出。
- 编辑器镜头修改随单段重生成进入新版本。

语法检查通过的主要文件：

- `server.mjs`
- `app.js`
- `server/api.mjs`
- `server/db.mjs`
- `server/storyboard-task.mjs`
- `server/knowledge-retriever.mjs`
- `server/media-task.mjs`
- `server/providers/openai-compatible.mjs`
- `server/providers/composer.mjs`
- `server/providers/comfyui.mjs`
