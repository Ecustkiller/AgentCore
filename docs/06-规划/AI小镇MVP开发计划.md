# AI 小镇（AI Town）MVP 开发计划

> **范围**：Phase 1 MVP（对齐 [多 AI 模拟愿景](../multi-ai-simulation-vision.md) Phase 1）
> **产品定位（2026-07-07 定案）**：MVP 卖点 = **「好看、能看的 3D AI 小镇」**——3D 观看体验是核心价值、非可选装饰。故**「基础一档美术（并入 FE-02，用 Kenney 现成低模）+ 30 FPS 硬底线」为必做**；高质量精修（FE-18）/ 进一步性能优化（FE-19）仍可降级；`SPIKE-01`（3D 能否跑通）升级为**卖点命门**，"降级 2D" 不再是优雅退路（见第 6 节）。
> **观看模型（2026-07-07 定案）**：同时支持**手动单步**（点一下现算一格）与**连续自动播放**（1x/2x/4x、可拖动），二者共同要求**「每 tick 先落库、播放时回读」**——故**存档/回读骨架前移到 M1–M2**（存储表 DB-01/02 在 M1，落库 BE-11 在 M2，回读/连播基础从 BE-28/FE-16/FE-17 拆出前置 M2），M4 只留时间轴滑块/热力图/跳转等**完善**。前移增量约 1–2 人天进 M1–M2，第 3 节人天待据此细化。
> **团队假设**：**2 名开发者（前端 / 后端各 1）+ AI 辅助**，每人 ~8 人天/周 → 团队 **~16 人天/周**
> **产能与预算**：7 周主线（~112 人天产能）+ 第 8 周缓冲；**committed 工作量 ~108 人天**，另有 ~13 人天降级池（第 8 周尽量清）
> **优先级铁律**：① **先验证产品赌注**——「10 个 LLM 居民能跑出可看的涌现」（最便宜的方式、最早，SPIKE-06）；② 再跑通「1 Agent + 手动 tick + 3D 动起来」管道闭环；③ 最后扩到 8–12 居民与核心交互
> **开发阶段声明**：项目当前**无任何真实运行数据**（无真实用户 / 对话 / eval 跑分 / 质量分）。本计划中一切「时延 / 成本 / 方差阈值」均为**假设**，须由 Spike 与合成样本实测校准，不得当既有事实引用。
> **状态**：`draft`（**3D 前端路线变更** → 见 [AgentTown 客户端规格](AgentTown客户端规格.md)：**Unreal Engine 5.5** 独立应用替代 Desktop R3F；后端与本计划 BE/DB 任务仍有效）
> **更新**：2026-07-08（UE 定案，原 Unity `UT-*` → `UE-*`）

---

## 0. 现状与复用锚点

> 路径均在 `apps/server/agentcore/`（前端在 `apps/desktop/`）下，下表用简写。
> **复用深度**：🟢 直接复用 / 🟡 以其为范本仿建 / 🔴 需扩契约或新建层（工时不可按「直接复用」估）。

| 已有能力 | 路径/组件 | 复用深度 | 模拟层用法与现实 |
|---------|----------|:------:|-----------|
| ReAct 决策循环 | `runtime/engine/loop.py` `react_loop()` | 🟢 | 可独立调用（`evals/harness.py` 已有直调先例），不强绑 conversation。作 SimAgent 每 tick 决策内核 |
| DB + Alembic + Repository | `db/repositories/conversations.py` 等 | 🟢 | 范式成熟；`sim_*` 表 + `SimXxxRepository` 照搬 |
| protocol-conformance | `packages/protocol-conformance/` | 🟢 | 已在用；`sim.*` 进 DURABLE 集时补向量 |
| 并发调度 | `runtime/runs/wave.py` `WaveScheduler` | 🟡 | 其调度单元是 **DAG 节点（RunSpec）**、非 SimAgent，且生产入口深绑 CEO/delegate。见「调度器决策」：tick 并发默认改用轻量 `asyncio.gather`，WaveScheduler 仅在出现 tick 内硬依赖时才用 |
| LLM 网关 | `llm/profiles.py` `llm/resolve.py` | 🟡 | 有 `agent.fast/agent.strong` profile 骨架，但**用户可见的分层选模已休眠**（`api/routes/model_modes.py`）；分层解析需参照 `evals/eval_modes.py` 自建 |
| 记忆 | `memory/store.py` | 🟡 | 是按 `folder_id` 的 markdown 文件树，**无 tick 边界情景记忆 API**；tick 对账为新建层，不能照搬 `consolidation` |
| 审计/Journal | `runtime/journal/` `runtime/audit/hooks.py` | 🟡 | 粒度是 **turn**、非 tick；tick 快照走新建 `sim_tick`，不复用 `turn_journal` 存储 |
| 桌面前端 | `apps/desktop/` `router.tsx` `sse/dispatch.ts` | 🟡 | Hash 路由与 SSE 泵送可仿照；现有 handler 强绑 chat/execution，需新增 sim dispatch |
| SSE 可观测 | `api/sse.py` + `runtime/events/` | 🔴 | 管道成熟，但新增 `sim.*` 是**契约级改动**：`EventType` 枚举 + `disposition.py` 门禁 + 代码生成脚本 + 前端 dispatch handler + conformance 向量，**五处齐动** |
| 前后端类型对齐 | `packages/contract-types/`（**非** `shared-types`）+ `contract-rest-types/` | 🔴 | SSE 事件名由 Python `EventType` 生成、**payload 手写**；REST 走 OpenAPI 生成；**无 Pydantic↔TS 双向 codegen** |
| 3D 渲染 | `apps/town/` Unreal Engine 5.5 | 🔴 | **2026-07-08 定案**：观测层改 **AgentTown 独立 UE 客户端**（→ [AgentTown 客户端规格](AgentTown客户端规格.md)）；Desktop R3F **冻结对照**，Phase 1 后删除。后端 BE/DB 不变 |
| **尚未存在** | `simulation/` 包 | — | 本计划核心新建项 |

**明确绕过**：`runtime/runs/` 的 CEO/DAG 路径、`conversation/` Turn 生命周期——模拟 run 独立生命周期。核实结论：绕过**方向合理**（ReAct 内核不依赖 CEO，eval 已有直调先例），现实工作量在**自建 sim 编排层**（prompt 装配、世界状态、持久化、SSE 契约、3D 同步），而非找不到内核。注意绕过 Turn 后将失去自动持久化 / `message_start` / `ApprovalGate`（后者需 `conversation_id`），如需须自建。

**调度器决策（激进简化）**：sim tick 的本质是「并发跑 N 个互相独立的 `react_loop`」，不含 DAG 依赖。故 M1/M2 默认用 **`asyncio.gather + Semaphore`** 直接编排，**不套 WaveScheduler**——避免拖入 delegate/notewall/contract 语义（呼应 dev-process「别为复用旧实现而裁剪需求」）。仅当后续出现 tick 内 Agent 间硬依赖时再评估引入。SPIKE-02 验证该并发路径。

---

## 1. 分阶段开发计划（5 里程碑 M0–M4 / 7–8 周）

### M0：技术 + 产品验证（Spike）— 第 1 周（与 M1 重叠）

**目标**：写业务代码前消除最高不确定性——**技术风险**（3D / 并发 / 绕过 ReAct）**与产品风险**（是否有涌现）。

### M1：最小闭环 — 2 周（第 1–2 周）

**目标**：1 个 SimAgent 在 3D 小镇场景中，手动推进 1 tick，SSE 可观测决策链。

**里程碑验收**：
- 点击「推进 1 tick」→ 后端 SimAgent 完成感知→思考→行动
- 3D 场景中 NPC 从 A 区走到 B 区（动作与后端位置同步）
- SSE 面板可见该 tick 的决策摘要
- 已推进的 tick 落库（`sim_tick`）并可按序号回读单帧——存档/回读骨架起步（为 M2 连续播放打底）

### M2：多 Agent 小镇核心 — 2 周（第 3–4 周）

**目标**：8–12 居民、24 tick/天、日夜循环、手动连续推进 5+ tick，数据落库。

**里程碑验收**：
- 10 个居民小镇可手动推进 5 tick，无崩溃
- 每 tick 快照写入 `sim_tick`，Agent 状态写入 `sim_agent`
- 已落库的多 tick 支持**连续自动播放**（含倍速），观看不阻塞于 AI 计算（回读/连播基础能力就位）
- 右侧面板可查看任意居民人设/情绪/当前目标

### M3：交互与事件 — 2 周（第 5–6 周）

**目标**：**3 种核心交互**（对话 + 交易 + 投票）可用，5 类事件调度器 + 4 个预设可注入事件，上帝模式可用。（冲突/结盟、八卦传播、公开演讲**移至 Phase 2**，见第 9 节）

**里程碑验收**：
- 同一 tick 内两个 Agent 可发起对话并完成交易
- 用户可注入「市场物价上涨」预设事件，下 tick Agent 行为可观测变化
- 镇政厅可发起一次投票并公示结果

### M4：观测体验与 MVP 交付 — 第 7 周（第 8 周为真缓冲）

**目标**：核心 UX 模式齐备（观察 + 跟踪 + 时间轴回放），20+ tick 可回放，3 次同配置运行宏观指标**可测量并如实报告**。资产精修 / 日报 / 性能深调 / conformance 向量列为**降级池**（第 8 周或验收硬需要时才做）。

**里程碑验收**（对齐愿景文档 Phase 1）：
- 8–12 居民，手动推进 **20+ tick**
- 每 tick 可观测完整 Agent 决策链
- 同一配置重复运行 3 次，**报告**宏观指标（人口情绪均值、交易总量、关系密度）方差；**「阈值如何确定」本身是 Phase 2 研究问题**（见风险 R6），MVP 不设硬阈值门。**注：宏观指标测不到卖点「好不好看」——「好看/有意思」的验收方式暂不定，待第一个可连播版本落地后再拍板（见 R6）**
- 非技术用户可在 **AgentTown** 内「观看」模拟（观察模式 + 跟踪模式）；Desktop 可选启动器

---

## 2. 任务分解表

> **前端路线（2026-07-08）**：原 `FE-*` / `SPIKE-01` / `SPIKE-05`（R3F）**不再新增**；等价工作见 **§2.1 `UE-*` Unreal 任务**。Desktop 仅保留 **DT-01**（`session.json` + 启动 AgentTown）。R3F 现有实现冻结作对照，UE Phase 1 验收后删除 `simulation/town/*`。

### 2.1 Unreal Engine 客户端任务映射（AgentTown · 替代 FE-*）

| 原 ID | 新 ID | AgentTown Phase | 标题 | 说明 |
|-------|-------|-----------------|------|------|
| SPIKE-01 | UE-00 | 0 | UE Spike | `apps/town` 空项目；Bearer 调 API；1 NPC + 坐标变换 Go/No-Go |
| SPIKE-05 | — | — | （废弃） | Zustand/R3F 帧率验证不再适用 |
| FE-01 | UE-01 | 1 | 应用壳 + Session | GameMode + `SimulationSession` 单状态机 |
| FE-02 | UE-02 | 1 | 7 区域场景 | Kenney 低模；`packages/town-assets` |
| FE-03 | UE-03 | 1 | 单 NPC NavMesh | Xbot 实例化 + Character NavMesh |
| FE-04 | UE-04 | 1 | REST + SSE 客户端 | 对齐 §6.6 事件表；Live 忽略 `tick_frame` |
| FE-05 | UE-05 | 1 | Tick 控制 UI | 推 tick / pause / 时钟（UMG） |
| FE-06 | UE-06 | 1 | 10 NPC + LOD | |
| FE-07 | UE-07 | 2 | 日夜循环 | 光照/天空 |
| FE-08 | UE-08 | 1 | 居民面板 | + `GET /manifest` roster |
| FE-09 | UE-09 | 2 | 事件时间线 | |
| FE-10 | UE-10 | 1 | Run 管理 | 本地历史；中期 **BE-UE-01** `GET /runs` |
| FE-11 | UE-11 | 3 | 交互 3D 叠加 | 气泡/交易/投票 |
| FE-12 | UE-12 | 3 | 上帝模式 UI | 对齐 M3 |
| FE-13 | UE-13 | 2 | 跟踪相机 | |
| FE-14 | UE-14 | 2 | 观测热力 + metrics | `GET /metrics` |
| FE-16/17 | UE-15 | 1 | 回放/倍速/跳转 | 仅 `GET /ticks/{n}` |
| FE-18/19 | UE-16 | 2–3 | 资产精修/性能 | 30 FPS 硬底线 |
| — | DT-01 | 1 | Desktop 启动器 | 写 `session.json`；「打开小镇」spawn AgentTown |
| — | BE-UE-01 | 2 | Run 列表 API | `GET /v1/simulation/runs`（可选中期） |

完整规格 → [AgentTown 客户端规格](AgentTown客户端规格.md)。

### M0 — Spike（第 1 周，与 M1 并行）

| ID | 模块 | 标题 | 描述 | 前置依赖 | 工时 | 可并行 |
|----|------|------|------|---------|------|--------|
| SPIKE-06 | 后端 | **涌现行为冒烟（产品赌注）** | headless 跑 3–5 个 SimAgent × ~10 tick（真实 LLM），人读 transcript 判断是否退化（复读 / 同质化 / 目标漂移 / 无聊）。**这是整个 MVP 的产品假设验证**，非管道验证。产出：行为样本 + go/no-go 判断 + 人设/prompt 调整建议。 | SPIKE-03 | 1.5d | SPIKE-01 |
| SPIKE-03 | 后端 | SimAgent 绕过 conversation 接入 ReAct | 验证不经过 `conversation/turns` 直接调 `react_loop`：构造 system persona + 工具集 + 轻量 EventSink，避免绑定 `current_journal_writer`。产出：接入样板代码。 | 无 | 1.5d | SPIKE-01, SPIKE-02 |
| UE-00 | Unreal | **UE Spike（替代 SPIKE-01）** | `apps/town`：REST Bearer 调通 create/tick/GET snapshot；1 NPC；wire→UE 坐标变换；Go/No-Go 到 `市场 (24,0,0)`。产出：可运行 exe + FPS 粗测。 | 无 | 3d | SPIKE-02, SPIKE-03 |
| SPIKE-01 | ~~前端~~ | ~~R3F~~ **已废弃** | → **UE-00**；R3F 代码冻结对照，不继续投入 | — | — | — |
| SPIKE-02 | 后端 | 并发 tick + **真实 LLM 时延/成本探针** | ① mock LLM 下用 `asyncio.gather+Semaphore` 跑 10/12 Agent 并发，测单 tick 墙钟与并发上限；② **用真实 LLM 跑 3 Agent × 2 tick，实测单次决策时延与 token 成本**，校准 R1 假设。产出：推荐 `max_parallel`、tick 超时策略、真实成本/时延基线。 | 无 | 2d | SPIKE-01, SPIKE-03 |
| SPIKE-05 | ~~前端~~ | ~~Zustand/R3F~~ **已废弃** | UE 单 Session 替代；无工时 | — | — | — |
| DT-01 | Desktop | session.json + 启动器 | 登录后写 `%APPDATA%/AgentCore/session.json`；`/simulation/town` 改「打开 AgentTown」 | UE-00 | 1d | UE-01 |
| SPIKE-04 | 集成 | 模拟 SSE 事件协议草案 | 定义 `sim.tick_started/ended`、`sim.agent_action`、`sim.interaction` 等 payload schema，走 `contract-types` 机制（Python `EventType` 生成事件名 + **手写 payload**）。产出：事件名枚举草案 + 手写 TS/Pydantic payload 对齐验证。 | 无 | 1d | SPIKE-01, SPIKE-03 |

**M0 小计**：约 **10 人天**（第 1 周并行；UE-00 +1d vs 原 Unity；SPIKE-01/03/06 的产出直接喂入 M1，非纯叠加）

### M1 — 最小闭环（第 1–2 周）

| ID | 模块 | 标题 | 描述 | 前置依赖 | 工时 | 可并行 |
|----|------|------|------|---------|------|--------|
| DB-01 | 数据库 | 四表 Alembic 迁移 | 新增 `simulation_run`、`sim_tick`、`sim_agent`、`sim_event` 四表及索引；字段覆盖：run 配置/种子/状态、tick 序号/快照 JSONB、agent 人设/情绪/位置、event 类型/payload。 | 无 | 2d | BE-01, FE-01, SPIKE-* |
| DB-02 | 数据库 | Simulation Repository 层 | 在 `db/repositories/` 新增 CRUD：创建 run、写 tick 快照、更新 agent 状态、追加 event。遵循现有 `conversations.py` 模式。 | DB-01 | 1.5d | BE-02 |
| BE-01 | 后端 | `simulation/` 包骨架 | 创建 `world/`、`agents/`、`interaction/`、`observe/`、`experiment/`、`scenarios/town/` 目录与 `__init__.py`；注册到 `agentcore` 模块树；添加 feature flag `SIMULATION_ENABLED`。 | 无 | 1d | DB-01, FE-01 |
| BE-02 | 后端 | WorldEngine 核心 | 实现离散 tick 推进器：世界时钟（tick 序号、小时 0–23）、共享状态容器（区域、资源占位）、随机种子、tick 前后钩子。不含 Agent 逻辑。 | BE-01 | 3d | DB-02, FE-02 |
| BE-03 | 后端 | SimAgent 人设与动机模型 | 定义 Pydantic 模型：姓名、职业、Big Five、目标栈、关系网、情绪标量。实现动机层接口（效用评估占位）。 | BE-01 | 2d | BE-02, FE-02 |
| BE-04 | 后端 | SimAgent 单 tick 决策循环 | 基于 SPIKE-03 结论，实现感知→思考→行动映射到 ReAct：构造 prompt（环境感知 + 人设 + 目标），解析行动意图（移动/待机/交互请求）。 | BE-03, SPIKE-03 | 3d | FE-03 |
| BE-05 | 后端 | 单 Agent Tick Runner | 串联 WorldEngine.advance() + SimAgent.decide() + 世界状态变更（更新位置/活动）。支持手动单步模式。 | BE-02, BE-04 | 2d | FE-04 |
| BE-06 | 后端 | 模拟 SSE 事件族（**契约级**） | 新增 `sim.*` 事件：`EventType` 加成员 + `disposition.py` 声明 DURABLE/DERIVED/EPHEMERAL + 代码生成脚本跑通 + WorldEngine/SimAgent 经 EventSink 发射。**注意五处齐动，非仅加事件工厂**。 | BE-01, SPIKE-04 | 3d | BE-04, FE-04 |
| BE-07 | 后端 | Simulation REST API | 新增 `api/routes/simulation/`：`POST /runs`（创建）、`POST /runs/{id}/tick`（推进一步）、`GET /runs/{id}/stream`（SSE）。复用 `api/sse.py` 包装。 | BE-05, BE-06 | 2d | FE-04 |
| ST-01 | 集成 | 模拟协议落地到 contract-types | 将 SPIKE-04 草案合入 `packages/contract-types/`：事件名进 Python `EventType`（生成 TS），**手写** `SimTickEvent`/`SimAgentState` payload 双端对齐。（**非** `shared-types`，无自动 codegen） | SPIKE-04, BE-06 | 1d | FE-04 |
| FE-01 | 前端 | 路由与页面壳 | Desktop 新增 `/simulation/town` 路由与 `TownSimulationPage`；布局：左侧 3D Canvas（70%）+ 右侧面板（30%）。 | 无 | 1.5d | BE-01, DB-01 |
| FE-02 | 前端 | 小镇 7 区域场景（基础美术必做） | R3F 场景：广场/市场/餐厅/工作场所×2/住宅/镇政厅/公园 7 个区域；**直接摆放 Kenney 现成低模资产作为「基础一档美术」（必做，非纯几何块）**；集成 Drei `OrbitControls`、环境光。 | FE-01, SPIKE-01 | 3d | BE-02 |
| FE-03 | 前端 | 单 NPC 寻路与动画 | 加载 1 个 Mixamo 角色，NavMesh 寻路，支持 `idle`/`walk` 状态切换；位置由 Zustand `agentPositions` 驱动。 | FE-02, SPIKE-01 | 3d | BE-05 |
| FE-04 | 前端 | Zustand Store + SSE 客户端 | `useSimulationStore`：连接 SSE、解析 `sim.*` 事件、更新 agent 位置/状态/事件流列表；新增 sim dispatch handler。复用 Desktop 现有 SSE 消费模式。 | ST-01, SPIKE-05 | 2d | BE-07 |
| FE-05 | 前端 | Tick 控制栏 | 底部工具栏：「推进 1 tick」「当前 tick / 时刻」显示；调用 `POST .../tick` API。 | FE-04, BE-07 | 1d | FE-03 |
| INT-01 | 集成 | E2E 最小闭环联调 | 联调：创建 run → 加载 1 Agent → 推进 tick → 3D 移动 + 右侧面板显示决策摘要。建立坐标契约测试，修复接缝 bug，产出 smoke test 脚本。 | BE-07, FE-03, FE-04, FE-05 | 2d | — |

**M1 小计**：约 **33 人天**（全程最紧的两周，见第 3 节口径说明）

### M2 — 多 Agent 小镇核心（第 3–4 周）

**目标**：8–12 居民、24 tick/天、日夜循环、手动连续推进 5+ tick，数据落库。

**M2 开发原则**：先把**架构和功能管道跑通**，再打磨内容和策略。具体来说：
- 居民人设、激活规则、模型选择等**内容/策略层**先用最简占位实现，功能验证后再迭代
- M2 验收看的是"多人能跑、数据能存、画面能看"，不考核"行为有多精彩"

| ID | 模块 | 标题 | 描述 | 前置依赖 | 工时 | 可并行 |
|----|------|------|------|---------|------|--------|
| BE-08 | 后端 | 批量 tick 并发执行器 | 每 tick 用 `asyncio.gather + Semaphore` 并发跑 N 个 Agent 的 `react_loop`；处理超时与单 Agent 失败隔离。**默认不套 WaveScheduler**（见第 0 节调度器决策）。 | BE-05, SPIKE-02 | 3d | BE-10 |
| BE-09 | 后端 | Agent 激活策略 | 提供激活接口（每 tick 决定哪些 Agent 参与推理）。**M2 先用最简实现（全员激活或固定规则），具体分层策略后续迭代。** | BE-08 | 2d | BE-10 |
| BE-10 | 后端 | AI 小镇场景配置 | `scenarios/town/config.py`：居民列表、区域坐标映射、日程模板的**配置骨架**。**M2 先用占位人设跑通管道，人设内容后续打磨。** | BE-03 | 2d | BE-08, BE-11 |
| BE-11 | 后端 | Tick 快照持久化 | 每 tick 结束将世界状态 JSONB 写入 `sim_tick`；Agent 状态批量更新 `sim_agent`；支持 run 暂停/恢复。 | DB-02, BE-08 | 2d | BE-12 |
| BE-12 | 后端 | SimAgent tick 记忆 | 新建 tick 边界记忆层：每 tick 结束写摘要，下一 tick 开始时将关键事实回灌 Agent。**M2 先做最简版（固定格式摘要），防幻觉漂移的精细策略后续迭代。** `memory/` 无 tick API，此为新建层。 | BE-04, BE-11 | 3d | BE-13 |
| BE-13 | 后端 | 模型路由 | 提供"不同场景可用不同模型"的路由接口，配置写入 run manifest。**M2 先全部走同一模型跑通，分层路由策略后续迭代。** | BE-08 | 2d | BE-12 |
| BE-14 | 后端 | 关系网与情绪更新 | tick 后处理：根据交互结果更新关系权重（-1~1）、情绪标量衰减/刺激；写入 agent 状态。 | BE-08, BE-10 | 2d | FE-06 |
| FE-06 | 前端 | 多 NPC 渲染 | 扩展至 10 个 NPC 实例（共享骨骼动画）；区域标签；简单 LOD。 | FE-03 | 2d | BE-08 |
| FE-07 | 前端 | 日夜循环视觉 | 24 tick 对应 0–23 时；光照/天空色渐变；UI 显示「第 N 天 · HH:00」。 | FE-02, BE-11 | 1.5d | FE-08 |
| FE-08 | 前端 | 居民面板 | 右侧 Tab：居民列表 → 点击高亮 3D NPC → 显示人设/性格/目标/情绪/关系。 | FE-04, BE-10 | 2d | FE-09 |
| FE-09 | 前端 | 事件流面板 | 右侧面板事件时间线：按 tick 折叠显示 `sim.*` 事件；支持按 Agent 筛选。 | FE-04, BE-06 | 2d | FE-08 |
| FE-10 | 前端 | Run 管理 UI | 创建新小镇 / 加载已有 run / 显示 run 状态；对接 `POST /runs`。 | BE-07, BE-10 | 1.5d | FE-06 |
| INT-02 | 集成 | 多 Agent 5-tick 联调 | 10 居民小镇连续手动推进 5 tick；验证并发调度、持久化、前端同步、记忆写入。修复并发接缝。 | BE-08, BE-11, FE-06, FE-08 | 2d | — |

**M2 小计**：约 **27 人天**

### M3 — 交互与事件（第 5–6 周）

| ID | 模块 | 标题 | 描述 | 前置依赖 | 工时 | 可并行 |
|----|------|------|------|---------|------|--------|
| BE-15 | 后端 | InteractionBus 基础 | 新建 `simulation/interaction/bus.py`：Agent 间消息路由；支持交互请求队列与 tick 内串行/并行策略。 | BE-08 | 2d | BE-22 |
| BE-16 | 后端 | 自由对话交互 | 两 Agent 对话协议：发起→接受→多轮 LLM 对话→结束；结果写入 `sim_event`；更新关系与情绪。 | BE-15 | 2d | BE-17 |
| BE-17 | 后端 | 交易交互 | 市场区域交易：物品/金钱交换（简化经济模型）；双方确认；写入 event 与世界状态资源。 | BE-15 | 2d | BE-18 |
| BE-18 | 后端 | 投票交互 | 镇政厅投票：议题发起、投票轮、结果公示；影响镇政决策状态机（MVP 简化版）。 | BE-15 | 2d | BE-22 |
| BE-22 | 后端 | 事件系统（5 类） | 实现日常/周期/随机/用户注入/涌现 5 类事件调度器；预设 **4 个**可注入事件模板。 | BE-02, BE-11 | 3d | BE-23 |
| BE-23 | 后端 | 上帝模式 API | `POST /runs/{id}/inject` 注入用户事件；`PATCH /runs/{id}/agents/{id}` 修改 Agent 参数。 | BE-22 | 1.5d | FE-11 |
| BE-24 | 后端 | 反思循环（低频） | 每 N tick（默认 6）触发 SimAgent 反思：总结近期行为、调整目标优先级；走大模型。可先每 12 tick 硬编码降级。 | BE-12, BE-13 | 2d | BE-22 |
| FE-11 | 前端 | 交互可视化 | 对话气泡、交易图标、投票进度条。（冲突/结盟/八卦动画随交互移至 Phase 2） | FE-06, BE-16 | 2d | FE-12 |
| FE-12 | 前端 | 上帝模式 UI | 事件注入面板（4 预设 + 自定义 JSON）；Agent 参数滑块。 | BE-23 | 2d | FE-13 |
| FE-13 | 前端 | 跟踪相机模式 | 点击居民 → 相机跟随 NPC 第三人称视角；ESC 回到鸟瞰。 | FE-06 | 2d | FE-11 |
| INT-03 | 集成 | 交互协议集成测试 | 覆盖对话+交易+投票 3 条路径的端到端测试；预设事件注入后 Agent 行为变化断言。 | BE-16~BE-18, FE-11 | 2d | — |

**M3 小计**：约 **22.5 人天**（较原计划 −7.5：交互降至 3 种 + 相关可视化降本）

### M4 核心 — 观测体验与 MVP 交付（第 7 周 · committed）

| ID | 模块 | 标题 | 描述 | 前置依赖 | 工时 | 可并行 |
|----|------|------|------|---------|------|--------|
| BE-25 | 后端 | 观测指标聚合 | `simulation/observe/`：每 tick 聚合宏观指标（情绪均值、交易总量、关系密度、区域人口分布）；SSE 推送 + 写入 tick 元数据。 | BE-11, BE-14 | 2d | BE-28 |
| BE-27 | 后端 | Run Manifest 与可复现性 | 导出 run manifest（场景配置、**固定种子**、模型版本、温度）；同 manifest 可重建 run；记录版本哈希。为方差可复现测量的基础。 | BE-10, BE-13 | 2d | BE-28 |
| BE-28 | 后端 | Tick 回放 API | `GET /runs/{id}/ticks/{n}` 返回历史快照；`GET /runs/{id}/replay` SSE 按序回放 tick 事件。**基础回读（单帧 + 按序回放）已前移 M2 支撑连续播放；本项 M4 只做完善（跳转/边界处理）**。 | BE-11 | 2d | BE-25 |
| FE-14 | 前端 | 观察模式总览 | 鸟瞰热力图：区域情绪色块、人口密度；宏观指标折线图（Recharts）。 | BE-25 | 3d | FE-16 |
| FE-16 | 前端 | 时间轴回放 | 底部时间轴滑块：拖动到任意 tick 回放世界状态；暂停/播放/单步；对接 replay API。**连续自动播放基础已前移 M2；本项为时间轴滑块/拖动等完善**。 | BE-28 | 3d | FE-14 |
| FE-17 | 前端 | 时间控制 UX | 播放速度（1x/2x/4x）、暂停/恢复自动推进、跳转到指定 tick/天。 | FE-05, BE-28 | 1.5d | FE-16 |
| INT-04 | 集成 | MVP 验收测试 | 自动化：10 居民 × 20 tick × 3 次同配置运行；**测量并报告**宏观指标方差（不设硬阈值门，见 R6）；产出验收报告。 | M3 核心, BE-27 | 2d | INT-05 |
| INT-05 | 集成 | 端到端 Smoke + 文档指针 | 保留 `pnpm -C apps/desktop sim:smoke:e2e`（HTTP）；UE 补 region/conformance Automation；落地指针迁入 `03-AI核心`。 | INT-04 | 1d | — |

**M4 核心小计**：约 **16.5 人天**

### M4 降级池 — 第 8 周（stretch / 进度紧张可砍）

| ID | 模块 | 标题 | 触发保留条件 | 工时 |
|----|------|------|------|------|
| BE-29 | 后端 | 性能调优 | tick 墙钟 > 60s 才必须做（激活剪枝、LLM 超时、失败隔离；目标 10 Agent tick < 60s） | 2d |
| FE-19 | 前端 | 3D 性能优化（进一步） | **30 FPS 为硬底线（必守）**——FPS < 30 则本项**上提为 committed**（实例化渲染、视锥剔除、阴影降级；目标 10 NPC ≥ 30 FPS 中端 GPU）；≥ 30 时进一步优化才可后移 | 2d |
| BE-26 | 后端 | 每日报告生成 | 体验增强，非验收硬需（每 24 tick LLM 生成日报） | 2d |
| FE-15 | 前端 | 每日报告视图 | 依赖 BE-26（右侧「日报」Tab + 导出 Markdown） | 2d |
| FE-18 | 前端 | 3D 资产**高质量精修** | **基础一档美术为必做**（已并入 FE-02，用 Kenney 现成低模，占位方块不作为交付形态）；此处仅指进一步高质量替换（Kenney+Quaternius 精修）可后移 | 3d |
| ST-02 | 集成 | 模拟 Conformance 向量 | 协议回归护栏，MVP 后补亦可 | 2d |

**M4 降级池小计**：约 **13 人天**（第 8 周尽量清；性能两项在指标未达标时上提为 committed）

---

## 3. 任务统计

| 里程碑 | 任务数 | 预估人天 | 日历周 |
|--------|--------|---------|--------|
| M0 Spike | 6 | 10 | 第 1 周（与 M1 重叠） |
| M1 最小闭环 | 16 | 33 | 1–2 |
| M2 多 Agent | 13 | 27 | 3–4 |
| M3 交互事件 | 11 | 22.5 | 5–6 |
| M4 核心 | 8 | 16.5 | 7 |
| **committed 小计** | **54** | **~109** | **7 周** |
| M4 降级池 | 6 | 13 | 8（缓冲/可砍） |
| **合计** | **60** | **~121** | **7–8 周** |

> **口径说明**：2 人（前后端各 1）+ AI ≈ 16 人天/周；7 周产能 112 人天，committed ~109 人天（含 UE Spike +1d）。**第 1–2 周为全程最紧**：M0(10) + M1(33) ≈ 43 人天，超两周产能（32），靠 SPIKE 与 M1 重叠消化——若 SPIKE 门未过则 M1 顺延、动用第 8 周缓冲。**第 8 整周为真缓冲**（吸收 UE 学习曲线与联调超支 + 尽量清降级池）。
>
> 原头部「48–56 人天」为单人口径笔误：121 人天工作量在单人 8 人天/周下约需 15 周，故实际须 2 人全程（团队 16 人天/周）才能压进 7–8 周。

---

## 4. 关键路径

以下任务延期将直接推迟 MVP 交付日期：

| 优先级 | 任务 ID | 原因 |
|--------|---------|------|
| 🔴 P0 | **SPIKE-06** | **产品赌注**：涌现不成立则整个 MVP 价值存疑，须最早验证 |
| 🔴 P0 | **SPIKE-03** | 阻塞一切 SimAgent 决策逻辑（也是 SPIKE-06 前置） |
| 🔴 P0 | **BE-04 → BE-05 → BE-07 → INT-01** | 最小闭环是后续所有工作的前提 |
| 🔴 P0 | **UE-00 → UE-03** | 3D 动起来是产品可见性锚点（UE，非 R3F） |
| 🟠 P1 | **BE-08** | 多 Agent 并发是从 demo 到产品的分水岭 |
| 🟠 P1 | **BE-15 → BE-16/17/18** | 3 种核心交互是 AI 小镇核心价值 |
| 🟡 P2 | BE-22, BE-25, FE-16 | 事件/观测/回放影响体验完整度，但不阻塞核心循环 |

**降级池 / 可推迟到第 8 周**：
- FE-18 **高质量**资产精修（基础一档美术已并入 FE-02 为必做）、FE-19 **进一步**性能优化（**30 FPS 为硬底线，未达则上提为必做**）、BE-29 性能调优（除非 tick > 60s）
- BE-26 / FE-15 每日报告、ST-02 Conformance 向量
- BE-24 反思循环（可先每 12 tick 硬编码）

---

## 5. 风险与缓冲

| # | 风险 | 影响 | 概率 | 应对策略 | 缓冲 |
|---|------|------|------|---------|------|
| R0 | **涌现不成立**：10 个 LLM 居民行为退化（复读/同质化/无聊），"不好看" | MVP 产品价值存疑 | 中 | **SPIKE-06 最早验证**；人设差异化 + 动机层硬约束 + 反思锚定；no-go 则先打磨单场景剧本再扩量 | SPIKE-06 不过则暂停扩量、回炉人设/prompt（用第 8 周缓冲） |
| R1 | **LLM 成本/时延**：10 Agent × 20 tick = 200+ 次推理，单 tick 可能超 60s | 无法交互式观看 | 高 | **SPIKE-02 用真实 LLM 打时延/成本基线**（不止 mock）；分层模型（需自建，非现成）+ 激活剪枝；非活跃 Agent 走规则行为；tick 超时降级 | M2 预留 BE-09/BE-13 各 1d 调参 |
| R2 | **行为漂移**：长运行后 Agent 忘记人设 | 验收失败 | 中 | tick 边界世界状态权威化；情景记忆写关键事实（BE-12 新建层）；每 6 tick 反思锚定；MVP 阈值设宽松 | BE-12 + BE-24 |
| R3 | **3D 性能**：10 NPC + 寻路 + SSE 导致卡顿 | 观测体验差 | 中 | UE-00 FPS 基线；UE-16 Profiler；位置按 tick snapshot 更新 | UE-16 / 降级池 |
| R4 | **接缝 bug**：后端位置与 3D 坐标系 / `sim.*` 事件契约不一致 | INT 联调反复 | 高 | M1 INT-01 即建坐标契约测试；`contract-types` 统一 `Vec3` + 事件 payload；conformance 向量棘轮 | 每里程碑 INT 各留 0.5d |
| R5 | **绕过 conversation 踩坑**：工具集/审计/成本计量/持久化缺失 | 后端返工 | 中 | SPIKE-03 充分验证；避免绑定 turn contextvar；复用 `runtime/audit/hooks.py` 思路；不复用 `ask_user`/审批门 | SPIKE-03 不成功则 +3d 方案重设 |
| R6 | **可复现性方法论**：带温度 LLM 天然高方差，且**开发期无真实数据可设阈值** | 验收标准不可证伪 | 高 | 验收改为「方差**可测量并如实报告**」；固定 seed + 记录 temperature/模型版本（Run Manifest）；"阈值确定"降级为 Phase 2 研究项。**另：宏观指标测不到卖点「好不好看」——「好看/有意思」的验收方式暂不定，待第一个可连播版本落地后再拍板（届时可选：组织观看 + 1–5 分评分 / 仅指标 / 其它）** | 不设硬阈值门，避免"调到能过" |

**缓冲说明**：**第 8 整周为真缓冲**（committed ~108 人天已排满第 1–7 周）+ 每里程碑 INT 内含 0.5d + M4 降级池（13 人天可砍）。最紧接缝在第 1–2 周（M0+M1 重叠），是缓冲最先被动用处。

---

## 6. 技术 + 产品验证优先项（Spike）

| 优先级 | Spike ID | 验证问题 | 成功标准 | 失败备选 | 时机 |
|--------|----------|---------|---------|---------|------|
| 🔴 必须 | SPIKE-06 | **10 个 LLM 居民能跑出可看的涌现吗？** | 3–5 Agent × 10 tick，人读 transcript 无明显退化、有可识别的目标驱动行为 | 收敛到"强剧本 + 少量自由度"，或调人设/prompt 再验 | 第 1 周末 |
| 🔴 必须 | SPIKE-03 | 能否不经过 conversation 跑通 ReAct？ | 单 Agent mock 环境完成 1 轮感知→行动，EventSink 有输出 | 薄封装 `conversation/local_turn` 伪 Turn | 第 1 天 |
| 🔴 必须 | UE-00 | UE + NavMesh + Xbot 能否跑通？（**卖点命门**） | 1 NPC；snapshot 驱动到 `市场`；≥ 30 FPS 粗测 | 同左；跑不通则砍其它保 3D，不降级 2D | 第 1–3 天 |
| ~~SPIKE-01~~ | — | 已废弃 → UE-00 | | | |
| 🟠 重要 | SPIKE-02 | 并发 tick 墙钟 + **真实 LLM 时延/成本**？ | mock 10 Agent < 10s；**真实 LLM 单决策时延/成本落在可交互区间** | 降并发 / 减活跃 Agent / 换更快模型档 | 第 1 周 |
| ~~SPIKE-05~~ | — | 已废弃（UE 单 Session） | | | |
| 🟡 建议 | SPIKE-04 | `sim.*` 事件契约前后端对齐？ | 事件名生成 + 手写 payload TS/Pydantic 一致 | 先用 JSON Schema 手工对齐 | 第 1 周 |

**Spike 决策门**：
- **UE-00** 或 SPIKE-03 在 **5 天内**未达成功标准 → **暂停 M1 功能开发**，先解决技术方案（最多额外 3 天）。
- SPIKE-06 判 no-go → **暂停扩量（M2 居民数），先回炉人设/prompt/动机层**；管道开发（M1）可继续，但不投入 M3 交互直到涌现成立。

---

## 7. 并行开发建议

### 双人模式（前后端各 1，主线）

| 角色 | 周 1–2 | 周 3–4 | 周 5–6 | 周 7 | 周 8 |
|------|--------|--------|--------|------|------|
| **后端** | SPIKE-02/03/06, DB, BE-01~07 | BE-08~14 | BE-15~18, 22~24 | BE-25/27/28, INT-04 | 降级池 BE-26/29 |
| **Unreal** | UE-00~05, DT-01 | UE-06~10, UE-15 | UE-11~13 | UE-14/07/16 | 降级池 UE-16 精修 |
| **Desktop** | DT-01 | 启动器维护 | — | — | — |
| **共同** | INT-01（第 2 周末） | INT-02 | INT-03 | INT-05 | 缓冲 / ST-02 / 收尾 |

### 单人 + AI 模式（备选，约需 15 周）

| 周 | 主线 | 说明 |
|----|------|------|
| 1 | SPIKE（含 06） → DB-01 → BE-01~05 | 后端优先，产品/技术风险先打 |
| 2 | BE-06~07 → FE-01~05 → INT-01 | 切前端完成闭环 |
| 3–6 | BE-08~14 → FE-06~10 → INT-02 | 交替推进（串行故耗时翻倍） |
| … | BE-15~24 → FE-11~19 → INT-03~05 | 交互 + 体验 + 验收 |

---

## 8. MVP 交付清单

| 愿景文档交付物 | 对应任务 | 状态目标 |
|---------------|---------|---------|
| `simulation/` 包骨架 | BE-01 | ✅ |
| World Engine MVP | BE-02, BE-08, BE-09 | ✅ |
| SimAgent 运行时 | BE-03, BE-04, BE-12, BE-13 | ✅ |
| AI 小镇 8–12 居民 | BE-10, FE-06 | ✅ |
| 手动 tick + 预设事件 | BE-05, BE-22, FE-05 | ✅ |
| 核心交互（对话/交易/投票） | BE-15~18, FE-11 | ✅ |
| AgentTown 3D 观测客户端 | UE-01~10, UE-15 | ⏳ |
| Desktop 启动器 + session.json | DT-01 | ⏳ |
| SSE 实时流 + 回放 + 连续自动播放 | BE-06, BE-28, UE-04, UE-15 | ⏳ |
| 数据库四表 | DB-01, DB-02 | ✅ |
| 20+ tick 可观测 | INT-04 | ✅ |
| 3 次同配置方差**可复现测量** | BE-27（固定 seed/版本）+ INT-04（测量报告） | ✅ |

---

## 9. 明确不在 MVP 范围（Phase 2+）

- **交互：冲突/结盟、八卦传播、公开演讲**（M3 降本移出，Phase 2 补齐）
- 每日报告 / 3D 资产精修 / 性能深调 / conformance 向量（列为 MVP 降级池，非硬承诺）
- 第二场景（博弈论 / 经济沙盘）
- 分叉对比（A/B 世界）
- 开放场景 DSL
- **无人值守长跑自治**（长时间无人介入的自主运行）——注意：**播放层的「自动连播 / 倍速」已纳入 MVP**（见头部「观看模型」），此处仅排除"无人监督的长时间自治长跑"
- Admin 端模拟管理页
- 100+ Agent 规模优化
- 独立 Web 应用（病毒性传播版）

---

## 相关文档

- [多 AI 模拟愿景](../multi-ai-simulation-vision.md)
