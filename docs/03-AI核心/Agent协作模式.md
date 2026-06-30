---
status: landed
code: apps/server/agentcore/runtime/runs/
related:
  - docs/03-AI核心/运行时总览.md
  - docs/03-AI核心/编排器与CEO主Agent.md
  - docs/03-AI核心/执行引擎架构设计.md
skip_if:
  - 只改 CEO delegate 字段（读编排器）
  - 只改 SSE fold（读执行引擎 §二）
---

# Agent 协作模式

> **状态**：已确定（编排器架构、协作范式、通信机制、冲突解决均已定）
>
> → 见代码：`apps/server/agentcore/runtime/runs/`

---

## 核心问题

Multi-Agent 系统中，Agent 之间如何协作？通信机制、冲突解决、任务编排的具体设计。

---

## 设计哲学：Multi-Agent First ✅ 已确定

AgentCore 以多 Agent 协作为默认范式，而非将其视为单 Agent 之上的扩展功能。

| 原则 | 含义 |
|------|------|
| **组合优于堆叠** | 新业务能力优先拆分为可组合的专职 Agent，而非在单个 Agent 的 system_prompt 中堆叠功能 |
| **单 Agent 是退化特例** | 一个独立 Agent 等价于「只有 Captain、没有成员的 Team」，运行时代码路径统一 |
| **委派是一等公民** | CEO 恒有 `delegate`；worker 由 `can_delegate` 显式授予，默认叶子（`MAX_DELEGATION_DEPTH=2`） |
| **编排可组合** | Pipeline / Fan-out / Adaptive 三种编排模式可嵌套（Team 成员可以是另一个 Team 的 Captain） |

### 统一执行路径

所有对话（单 Agent / Team）走同一条代码路径，差异仅在委派工具的注入和编排策略的选择：

单/Team 同一执行路径，差异在 delegate 注入与编排策略（见 `/docs/03-AI核心/编排器与CEO主Agent.md`）。

### 开发指导

- **新增业务功能时**：先问「这是独立 Agent 还是现有 Agent 的工具？」，优先选择独立 Agent + 委派
- **设计 system_prompt 时**：保持单一职责，复杂任务通过委派拆解

---

## 一、协作范式 ✅ 已确定

MVP 支持四种范式，**串行/并行/混合均由 `delegate` 的 DAG（`depends_on`）+ CEO 收尾统一表达**；执行层无 debate 专用路径（辩论的 `plan_type=debate` 仅前端呈现标记，底层仍普通 DAG）。CEO 在一次 `delegate` 里用 `depends_on` 定序（无依赖即并行）表达串行/并行/混合；用户无需手动指定范式。**辩论/审查**已落地为「主持人驱动的逐轮交锋 → 双产物」（✅，见 §7.4 与 [`辩论编排设计.md`](/docs/03-AI核心/辩论编排设计.md)）——主持人是 `debate` 工具内的确定性编排循环而非执行分支，故底层「无 debate 专用执行路径」仍成立。

| 范式 | DAG 表示 | 场景举例 | 状态 |
|------|---------|---------|---------|
| **串行流水线** | A → B → C（`depends_on` 链） | 调研→分析→报告 | ✅ |
| **并行分工** | A ∥ B → CEO 收尾 | 同时研究多个方面 | ✅ |
| **辩论/审查** | 主持人驱动逐轮交锋 → 简报+过程双产物 | 方案对比、红队审查、多方圆桌 | ✅（见 §7.4） |
| **混合** | 串行 + 并行组合 | 先并行调研，再串行综合 | ✅ |

> 执行形状是**数据不是模式**：由 `delegate` 的 `depends_on` 边自然落定。

---

## 二、通信机制 ✅ 已确定

Agent 间**不直接通信**——上游产物经调度器中转注入下游；另有**被动协作通道**（扇出感知、拓扑位置感知、worker `escalate` 升级经 CEO 中转），以及波内**主动共享**的**便签墙**（§波内共享上下文：便签墙）。产物传递 / 递指针 / 工作区清单 → 见 [`编排器与CEO主Agent.md` §2.3](/docs/03-AI核心/编排器与CEO主Agent.md)。

> **扇出兄弟判据**：兄弟 = 共享同一 `depends_on` 集（刻意窄于「同拓扑波」）；扁平并行批是全体无依赖的退化特例。

### 为什么不要 Agent 直接通信

- Agent 间每次通信 = 额外 LLM 调用，成本和延迟翻倍
- 通信内容平台看不到，失去控制和可观测性
- 经产物中转更简单，且天然支持任意范式

### worker `escalate` 升级通道 ✅ 已落地

worker 唯一的向上通道。`blocking=false`（默认）= 上报后按 `assumption` 继续交付，CEO 收尾纠偏；`run_escalation` SSE 让升级进行中可见。

**阻塞式求决策（`blocking=true`）✅**：worker 撞上「只有用户能定、猜错就作废」的岔路时，经 `ToolContext.escalation` 端口挂起等用户；超时回落非阻塞行为（按 `assumption` 续跑）。**采纳 worker→用户**（复用 `InteractionRegistry` + `ESCALATION` kind），**否决 worker→CEO 波内重入**——CEO 调 `delegate` 后 ReAct 停在工具调用上，波内无活着的 CEO。

**结构化提问 ✅**：岔路若是干净的 A/B 或多选，worker 可附**结构化 `questions`**（结构同 `ask_user`：choice/text + `options`/`default`，随 `escalation_required` 下发），挂起卡复用 `ask_user` 的问答内核渲染，用户一键拍板而非读散文手敲；纯开放问题则省略、回退自由文本。关键约束：**前端把选项选择拍平成纯文本答复**回填，故后端 resolve 契约（`{answer, use_assumption}`）与挂起恢复路径**保持不变**；`questions` 为 desktop-local（不进 conformance golden），手机端忽略至其应答卡落地。

| 约束 | 取值 |
|---|---|
| 武装门 | 与 `ask_user` 同闸（`checkpoint_enabled` + live client）；无 live user 时自动退化非阻塞 |
| 超时 | 复用 `checkpoint_timeout_seconds` |
| 同回合并发阻塞上限 | 3（超出退化非阻塞） |
| 回合状态 | 阻塞升级**不**翻 `paused`（兄弟继续跑）；`escalation_required`/`escalation_resolved` 单一发射者 = awaiter |

**`kind` 三档（非阻塞，喂波边界）✅ 已落地**：`normal`（普通上报）/ `scope`（职责偏离）/ `dep`（依赖缺口）。后两者**同走反应臂波边界**（`wave.py::_scope_pending` + `BoundaryReason.SCOPE` 一处机器）被 CEO / lead 一等消费：

- `kind=scope`：worker 发现自己 / 下游 scope 错了 → 主管在波边界**操舵已有步骤**纠偏（计划漂移）。
- `kind=dep`：worker 卡在一个**还不存在**的输入 / 依赖（没人产出过、计划也没安排）→ 主管在波边界用 `replan(add)` **追加一个产出它的步骤 / 接一条依赖边**。它是「变·拉取」里「东西不存在」那一支（见 §波内共享上下文：便签墙·拉取）。

worker 全程 non-blocking、照常按假设把能做的做完；简报（`supervised.py::format_scope_boundary`）按 kind 分标「偏离 / 缺输入」并指向对应 `replan` 杠杆，无下游可补时退回收尾路。**度量不串**：`dep` 计入总升级数但**不进** `scope_escalations`，漂移率口径仍纯。执行语义见 [执行引擎 §一·受监督的波循环](/docs/03-AI核心/执行引擎架构设计.md)。前端：`EscalationCard`（结构化升级与 `ask_user` 共用问答内核 `AskUserFields`）、图节点「待你拍板」角标；⏳ 手机交互层（fold 已有、应答卡未落地）。

> **schema 姿态（2026-06-30）**：`normal` / `blocking` 克制使用（小事自行假设别升级、blocking 省着用，避「问题墙 / 动辄打断用户」反模式）；**唯独 `dep` 该喊就喊**——真卡在「再猜也是错」的缺口上别硬猜瞎编，主动发 `dep` 强过闷头产一堆作废的东西。

→ 见代码：`tools/builtin/escalate.py`、`runtime/interaction.py`（`ESCALATION`）、`runtime/runs/executor_agent.py`（`_escalation_channel`）

### 波内共享上下文：便签墙（NoteWall）✅ 已落地

**解决的痛**：同扇出的并行兄弟过去只看到「开局快照」（队友产物去重清单 + 兄弟感知块），波内**看不到彼此「进行中」的发现**——各自猜接口 / 字段、最后才发现对不上、返工。便签墙把「开局冻住的快照」升级为「**边干边更新的共享面**」，让「中间的互相影响」真正发生。

**本质是「贴便签」，不是「打电话」**（故仍守 §为什么不要 Agent 直接通信）：

- **贴在明处**：每张便签是一条被记录的事件（`team_note_posted`，入 journal），能 fold 进团队卡「团队便签」面板——平台全可见，守玻璃箱。
- **不要求回应**：贴完接着干自己的、不等回复（顺手副作用），顺带保证**不会无限绕圈**（没有「你回我我再回你」）。
- **避开直聊两毛病**：黑盒 + N² 调用都不存在。

**便签四能力（worker-only，闭集、防滑向聊天区）**：

| 能力 | 工具 | 语义 |
|---|---|---|
| 我定了 X | `post_note(kind=decision)` | 别人要依赖的决定：接口 / 字段名 / 格式 / 命名 |
| 提个醒 Y | `post_note(kind=heads_up)` | 我踩到的坑 / 发现（如「这个模块是异步的」）|
| 我领了 Z | `post_note(kind=claim)` | 避免重复 / 撞活——`WriteCoordinator` 防撞的**台面化** |
| 拉取 | `read_notes` | 干到一半需要某队友已定的接口 / 约定却想不起来 → 主动翻当前整面墙（纯读·排除自己·不动推送游标）|

> **「我卡在 W」不走便签**：缺一个**还不存在**的输入是**计划问题**，走 `escalate kind=dep` + 边界 `replan(add)`（见上 §escalate）。「缺」分两种正好对到两件：(a) 东西已存在 → `read_notes` 读出来；(b) 不存在 → `escalate kind=dep`。

**便签会过期——可改写 / 作废（supersession）✅**：`amend_note`（worker 只能改自己的活跃便签，防 cross-worker edit war）把目标便签翻 `superseded`（改写）或 `voided`（作废），带 provenance + `supersedes`。**仅推 / 仅收 ACTIVE**——被改写 / 作废的不再推增量，直治「陈旧传播 / 矛盾常驻」这一多 Agent 头号坑。

**推增量 + 拉整墙**：

- **推（默认）**：每个兄弟动下一步前，引擎 `on_round_begin` 钩子把「上次之后新贴、且非自己贴的」便签（`new_for` per-run 游标）渲成一条 user 消息塞进去——新鲜、互相影响真发生。
- **拉（按需）**：`read_notes` 主动翻整墙。

**护栏（不烧爆 / 不失控）**：`MAX_NOTE_CHARS=200`（一行硬截断）/ `MAX_WALL_NOTES=50`（满了丢最旧）/ `MAX_PUSH_PER_ROUND=8`；**可见域 = 同一扇出批**（一个 `build_agent_executor` 生命周期一面墙，非全树）；脱队（无并行兄弟）返干净的「无队友可看」结果而非假装贴成功。

**并入「合·对账」收尾**：CEO 收尾时读 `NoteWall.active_notes()`（全队当前有效便签），经 `format_notes_for_synthesis` 渲成概览里的【团队便签】清单，并把语义边界对账（见 [`编排器与CEO主Agent.md` §一·合·验证](/docs/03-AI核心/编排器与CEO主Agent.md)）指到它（改了成品没跟 / 两人认领同一块 / 成品与广播决定矛盾 → 就地 `revise`/`replan`）。

**三端一致折叠**：`team_note_posted`（journaled，随 delegate 回合 surface、重载可回放）三端 fold 到 `ProjectedTurn.teamNotes`（按贴出序、`noteId` 去重，与图节点 / process 正交），据 `supersedes` 翻 target 状态渲「已被更新 / 已作废」；桌面 `TeamNotesPanel`、手机 `TeamView` 渲染。

> **被否决**：worker↔worker 点对点直聊（见 §为什么不要 Agent 直接通信）——便签墙正是「兄弟需横向对齐」这个真需求的**结构化可观测**答案。**变味信号**：若便签被拿来「你问我答、来回讨论」就是在往聊天滑，立即收住（回到「贴事实、不要求回应」）。

→ 见代码：`runtime/runs/notewall.py`（`NoteWall`：`post`/`amend`/`new_for`/`all_for`/`active_notes`）、`tools/builtin/post_note.py` / `read_notes.py` / `amend_note.py`、`runtime/engine/loop.py`（`on_round_begin`）、`runtime/runs/executor_agent.py`（`_pull_notes`）、`runtime/events/run.py`（`team_note_posted`）、三端 fold（oracle `conformance/projection.py` + 桌面 `stores/execution` + 手机 `protocol/fold.ts`）。

---

## 三、冲突解决 ✅ 已确定

CEO 是唯一裁决者，用户裁决仅在置信度低时触发。

| 冲突类型 | 解决方式 |
|----------|---------|
| 意见冲突 | CEO 读取各 worker 产物后裁决（收尾时综合） |
| 资源冲突 | DAG 依赖关系避免并发写入 |
| 优先级冲突 | CEO 负责任务排序（`delegate` 的 `depends_on`） |
| 置信度低（阻塞 / 非阻塞） | CEO 调 `ask_user`（默认挂起；`blocking=false` 时问而不停）→ 见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md) |

---

## 四、任务编排 ✅ 已确定

CEO 主 Agent、`delegate` 按需委派与 DAG 波次调度——→ 见 [`编排器与CEO主Agent.md`](/docs/03-AI核心/编排器与CEO主Agent.md)、[`执行引擎架构设计.md`](/docs/03-AI核心/执行引擎架构设计.md)。

---

## 五、Multi-Agent 设计约束 ✅ 已确定

> 基于行业实践提炼的行为约束；已落地的见各专题文档，未落地条目标 ⏳。

| # | 约束 | 现状 |
|---|------|------|
| 1 | **单一职责** | ✅ 每 Agent 一个明确职责 |
| 2 | **强制上层委派** | ✅ 任务传递只走编排器调度 |
| 3 | **读写分离** | CEO 只读 / worker 变更（⏳ `mutation` 工具过滤未实现） |
| 4 | **上下文最小传递** | ✅ worker 隔离上下文，不全量历史 |
| 5 | **分层熔断** | ✅ 引擎 `LoopController`（⏳ Redis 熔断 fail-open 未实现） |
| 6 | **幂等性执行** | ⏳ 写操作 idempotency key 未实现 |
| 7 | **模型分级** | ✅ fast/strong + 质量档（内测休眠）→ 见编排器 §2.1 |

---

## 六、产物传递与共享工作区 ✅ 已确定

上游产物如何传到下游、递指针与工作区清单——→ 见 [`编排器与CEO主Agent.md` §2.3](/docs/03-AI核心/编排器与CEO主Agent.md)（本篇不重复展开）。

**补充决策**：删对话时**绝不丢用户主动产出的交付物**；系统备份安全网**只追加、从不覆盖**。

---

## 七、多 Agent 运行时机制

> 委派地基**已落地**；**§7.2 Preflight / §7.3 Team 编排 / §7.5 A2A 仍为 Phase 2**。

### 7.2 委派预审（Preflight Audit）⏳ 未实现

Captain 委派的两阶段「提案 + 审计 + 确认执行」流程；有界预检环（每轮最多 N 次 audit）——待 preflight 审计回归落地。

### 7.3 Team 编排（Orchestration）⏳ 未实现

Team 实体 + `orchestration` 字段为 Phase 2；执行形状语义 → 见 [`执行引擎架构设计.md` §8.4](/docs/03-AI核心/执行引擎架构设计.md)。

### 7.4 辩论 / 审查：主持人驱动 ✅（详见专题文档）

辩论 / 交叉审查从旧的「`delegate` 上的 `stance`/`round` 展示标记 + CEO 手搓跨轮 DAG」重设计为「**主持人（Moderator）驱动的逐轮交锋 → 决策简报 + 交锋叙事线双产物**」（已落地）。完整设计（主持人循环、三形态、双产物、收敛轮次治理、老板介入、技术落点）见 **[`辩论编排设计.md`](/docs/03-AI核心/辩论编排设计.md)**（辩论单一权威源）。

要点：

- **主持人是编排角色，不是执行引擎**：底层仍是普通并行委派 + 上游产物注入（守「形状是数据」——无 debate 专用执行分支）；主持人落成 `debate` 工具内的确定性循环（非 LLM 委派角色），辩手是工具内派出的 `depth+2` 叶子，仍卡在 `MAX_DELEGATION_DEPTH=2` 内。
- **轮次收敛驱动、对用户隐藏**：取代旧的「一次 `delegate` 静态展开 2N 节点」，改由主持人逐轮判收敛（无新论点 / 焦点澄清 / 安全上限）后自停；用户只选形态、不设轮数。
- **辩手跨轮带记忆**：复用 `continue_run` 续写（`revise` 的同源原语，`DebateTool` 直接持有辩手 session、无需下放工具），辩手在自己 transcript 上续写，取代旧的「每轮全新失忆 worker」。

> **被否决：独立 Arena 子系统**（独立 SSE + 状态机 + 阶段轮转引擎 + `arena` RunKind）——**仍否决**。主持人复用 DAG 调度，只补回「主持 / 收敛 / 产物」产品层，不是独立引擎。`arena` RunKind 已删，best-of-N 归 `RunPolicy.candidates`。
> **被替代：CEO 手搓静态辩论 DAG + `round` display-only 标记**——理由（轮数先验固定 / 手搓依赖易错 / round 与依赖脱节）见 [`辩论编排设计.md §八`](/docs/03-AI核心/辩论编排设计.md)。
> **落地修正：主持人 = `debate` 工具内确定性循环**（非初稿设想的 depth-1 `can_delegate` LLM 角色）——更可控可测、省一层编排 token，理由见 [`辩论编排设计.md §7.1`](/docs/03-AI核心/辩论编排设计.md)。

### 7.5 Agent 通信协议 (v1)⏳ 未实现

委派从进程内函数调用升级为标准化协议交互，内外部 Agent 走同一接口（⏳ A2A 风格：`AgentCard` / `TaskRequest` / `TaskResponse`，参考 Google A2A）。

协议参考 A2A 但更轻量，面向内部 Agent 间通信。远程委派作为协议扩展位保留。

### 7.6 运行时基础设施

波次调度、挂起续跑、收敛治理等机制见 [`执行引擎架构设计.md`](/docs/03-AI核心/执行引擎架构设计.md) §四、§八。

**并发预算被否决方案**：树级共享 Semaphore——父持槽 await 子、子又抢同一信号量 → 必然死锁。

---

## 八、团队设计模式 ⏳ 已确定方向

> 从早期多 Agent 团队实践中提炼的设计原则；**未见独立代码模块对应**，作编排参考保留。

**核心原则**：角色从「不可合并的认知模式」推导（编排 / 设计 / 实现 / 评判 / 事实确立）；同一模式可合并、不同模式不可合并；评判者与实现者读写分离；拍平纯路由层、行业参数化 prompt、有界自动返工（≤2–3 轮）。