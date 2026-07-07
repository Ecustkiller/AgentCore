---
status: ⏳ Phase 1 已落地，Phase 2 第一批实施中，Phase 3 待定
related:
  - docs/05-平台与运维/安全权限与治理.md
  - docs/03-AI核心/编排器与CEO主Agent.md
  - docs/03-AI核心/Agent协作模式.md
  - docs/03-AI核心/执行引擎架构设计.md
  - docs/02-架构/后端架构.md
code: apps/server/agentcore/runtime/
---

# 多 Agent 协作审计功能

> **定位**：多 Agent 协作场景下「审计与追溯」的产品与技术规划讨论稿。每个议题自成一节，供逐项决策。
>
> **讨论状态**：十个议题已于 2026-07-06 逐项讨论确认，决策标注于各节 ✅。
>
> **Phase 1 落地**：2026-07-06。→ 见代码：`runtime/audit/`（含 `AuditRecorder` 采集链、`agent_audit_events` 表、双 API、级联删）。迁移 `e8f1a2b3c4d5`。
>
> **治理**：Phase 1 结论已迁入 [`安全权限与治理.md` §八](/docs/05-平台与运维/安全权限与治理.md)；Phase 2–3 仍留本文 ⏳。全阶段完成后迁入 `01`–`05` 并退役。
>
> **背景锚点**：[`安全权限与治理.md`](/docs/05-平台与运维/安全权限与治理.md) §八 已记录 Phase 1 现状；§十 已沉淀安全不变量，但**不含**多 Agent 行为追溯细节。Phase 2–3 设计仍见本文。

---

## 总览

### 背景：多 Agent 协作下审计的特殊挑战

单 Agent 对话的审计近似「一条时间线 + 工具调用列表」。多 Agent 协作引入四类单 Agent 不存在的追溯难题：

| 挑战 | 说明 | 现有基础设施能否部分覆盖 |
|---|---|---|
| **决策归因** | 「这个文件是谁写的」可能对应 worker A，但触发它的可能是 CEO 的 delegate 规划、上游 B 的 pass_through 注入、或便签墙上的 decision | `turn_journal` 有 run/tool 事件，但**无统一审计查询面**；`cost_events` 按 run 归因花费，不记决策链 |
| **并行因果链** | 同波 4 个 worker 并行时，时间戳无法表达「C 的输入依赖 A+B 的产出」 | `depends_on` / `parent_run_id` / `execution_id` 已在 Run 模型与 SSE payload 中；**未投影为可查询因果** |
| **跨 Agent 数据流** | pass_through 全文注入、便签墙广播、文件产物指针——敏感数据在 Agent 间流转但平台需可观测 | 内容在 `RunState` / journal / 消息中已有副本；**缺独立的流向审计元数据** |
| **权限传播** | `can_delegate` 嵌套、`tools` 白名单收窄、审批「整棵 DAG 共享」——实际生效权限与声明可能不一致 | `ApprovalGate` 有运行时行为；**无持久化权限事件** |
| **修订重试** | `revise` / `replan` / 节点 `retry` 会改写执行路径，「最终态」与「曾尝试过的路径」需区分 | journal 可回放；`RunSessionRow` 保 transcript；**无轻量审计索引** |

### 与现有基础设施的关系

```
用户消息
    │
    ▼
Turn Journal (turn_journal) ──► 前端 fold → ProjectedTurn / GraphView
    │                              （用户可见「团队做了什么」）
    ├── SSE EventSink.emit ──► 实时 UI
    │
    ├── cost_events ──► 按 run 计费台账
    │
    ├── turn_metrics ──► 运营聚合（委派率 / 漂移率 / 返工率）
    │
    ├── ApprovalGate ──► approval_required / resolved（交互，部分入 journal）
    │
    └── logs/dev.jsonl + trace_id ──► 开发排障（⏳ trace 跨链路未完全统一）

【本文提议】agent_audit_events ──► 面向审计的 append-only 专表 + 查询 API
```

**不重复建设的原则**：

- **Turn Journal 仍是回放与 UI 的单一事实源**——审计表不替代 journal，而是从 journal + 运行时钩子**投影**出便于查询的审计视图。
- **成本台账 (`cost_events`) 仍是钱的单一事实源**——审计只引用 `run_id` / `message_id`，不复制 token 明细。
- **管理后台审计 (`admin_audit_logs`) 只管人工治理操作**——与 Agent 自动行为审计分表、分受众。

### 本文范围

| 在范围内 | 在范围外 |
|---|---|
| 多 Agent 委派树内的编排决策、工具副作用、审批、Agent 间通信、状态迁移、失败重试 | 单 Agent 纯聊天（无 delegate）的审计——可由同一套机制覆盖，但 **MVP 优先级低** |
| 终端用户「我的 AI 做了什么」+ 平台运营监控 | 合规级长期归档、法定留存格式（Phase 3） |
| 与 `execution_id` / `parent_run_id` / `depends_on` 对齐的因果追溯 | 独立因果图存储引擎 |
| 权限传播与审批授权的审计记录 | RBAC/ABAC 权限模型本身（仍属 §九 其他待定项） |

---

## 议题一：审计受众与目标

### 问题

同一套审计数据无法同时最优服务三类受众——他们的「成功标准」和「可读性要求」冲突。

| 受众 | 核心问题 | 典型场景 | 数据敏感度 |
|---|---|---|---|
| **终端用户** | 「我的 AI 团队做了什么？为什么做这个决定？」 | 「这个文件是谁写的」「为什么删了那个配置」「审批是谁点的允许」 | 只看自己的对话；要**叙事可读**，不要 raw JSON |
| **平台运营** | 「系统是否健康？滥用/异常在哪里？」 | 「过去一小时工具调用失败率」「某用户委派深度异常」「审批超时率」 | 跨用户聚合；**可索引、可告警** |
| **合规审计** | 「能否证明操作经过授权、可追溯、不可篡改？」 | 监管检查、企业采购安全问卷、事故取证 | 长期留存、导出、**防篡改**、与身份绑定 |

### 备选方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 三受众一期全做** | 统一 schema + 三种 UI/API | 无技术债 | 合规要求（WORM、签名、法定格式）拖慢 MVP 数月 |
| **B. 只做运营** | 复用 `turn_metrics` + 日志 | 最快 | 用户「我的 AI 做了什么」仍只能靠回放团队卡，无法回答归因问题 |
| **C. 用户 + 运营 MVP，合规后期** | Phase 1–2 服务前两者；Phase 3 加固留存与导出 | 对齐产品价值（用户信任 + 运营可观测）；合规需求可随企业客户出现再加深 | 早期无法满足严格合规采购 |

### **推荐：方案 C**

**理由**：

1. **产品三问**：谁用——先是有 AI 团队行为的终端用户与需要排障的运营；合规采购是 🗂️ 尚未出现的真实需求（无企业客户数据支撑优先级）。
2. **现有基础**：`turn_metrics` 已覆盖运营侧**回合级**聚合；缺口在**步骤级归因**与**用户可读查询**——这正是 Phase 1 该补的。
3. **与 §十 的关系**：安全不变量已坐实；合规审计是**在不变量之上的增值层**，不阻塞核心产品。

**MVP 成功标准（可验收）**：

- 用户：在对话内能查到「某文件首次写入的 run + 触发它的上游依赖」。
- 运营：能按时间窗聚合「工具失败 / 审批拒绝 / 嵌套委派深度」。

### ✅ 决策

按推荐**方案 C**走：MVP 服务终端用户 + 平台运营，合规 Phase 3。无调整。

---

## 议题二：审计事件分类与粒度

### 问题

记录太细 → 存储与查询成本爆炸；记录太粗 → 无法回答归因与合规问题。多 Agent 场景需要在「排障价值」与「成本」间取平衡。

### 备选方案

| 方案 | 记录范围 | 存储成本 | 排障价值 | 合规适用性 |
|---|---|---|---|---|
| **A. 全量记录** | 每个 SSE 事件 + 每个 LLM 轮次 + 每条 delta | 高（流式 delta 不可接受） | 最高 | 高 |
| **B. 仅副作用操作** | 写文件 / 执行代码 / 外部 HTTP / 审批结果 | 低 | 中（丢失「为何委派」） | 中 |
| **C. 仅决策点** | delegate / replan / revise / checkpoint / approval / escalate | 最低 | 低（丢失工具失败细节） | 低 |
| **D. 决策点 + 副作用 + 关键状态迁移** | B ∪ C ∪ 失败/重试/权限变更 | 中 | 高 | 中高 |

### 按事件类别清单（方案 D 的细化）

| 类别 | 具体事件 | 是否 MVP | 说明 |
|---|---|---|---|
| **编排决策** | `delegate` 规划（tasks 摘要）、`replan`（binds/steers/add/stop）、`playbook` 实例化 | ✅ | 记**结构化摘要**（task id / role / depends_on / tools 收窄），不记 CEO 全文 prompt |
| **工具调用** | `tool_use_start` / `tool_use_end`（GRANTABLE + NEVER） | ✅ 副作用优先 | GRANTABLE **全记**；只读类（`file_read` / `grep`）**采样或聚合** 🗂️（见下） |
| **审批** | `approval_required` / `approval_resolved`（含 scope：一次 / 本轮 / 文件类） | ✅ | 与 [`安全权限与治理.md` §三](/docs/05-平台与运维/安全权限与治理.md) 对齐 |
| **Agent 间通信** | `team_note_posted` / `amend_note`、`escalate`（含 kind）、`run_context` 注入 | ✅ | 记元数据 + 摘要；便签正文 ≤200 字可全文（与 NoteWall 上限一致） |
| **状态迁移** | `run_started` / `run_completed` / `run_failed`、`plan_revised`、检查点挂起/恢复 | ✅ | `RunPhase` 变化 + `finish_reason` |
| **异常与失败** | worker 失败、`on_failure` retry、用户 `retry-failed`、`revise` 热修 | ✅ | 含 `error` 摘要 + `attempt` 序号 |
| **流式传输** | `content_delta` / `run_output_delta` / `reasoning_delta` | ❌ | 已在消息体 / journal；审计不重复 |
| **成本** | token 用量 | ❌ | 引用 `cost_events` |

**只读工具是否记录** 🗂️：

| 子方案 | 做法 | 推荐倾向 |
|---|---|---|
| D1. 不记录只读 | 仅 GRANTABLE | 省存储，但无法审计「谁读了哪个文件」 |
| D2. 记录只读摘要 | 工具名 + 路径/查询参数哈希 + 结果大小 | **推荐作 Phase 2**（企业数据访问审计常见要求） |
| D3. 全记录只读 | 每次 file_read 一行 | 扇出调研场景可能爆量 |

### **推荐：方案 D（MVP），只读类走 D1，D2 作 Phase 2 开关**

**理由**：

1. 多 Agent 归因的最低必要集 = **编排决策 + 副作用工具 + 审批 + 通信 + 状态/失败**——缺任一都会留下「黑箱接缝」。
2. 全量（A）与 journal 重复且含 delta，**违反「审计表是投影而非第二事实源」**。
3. 只读审计在企业场景常见，但 MVP 无真实客户需求证明其优先级；用 **feature flag** 预留 D2 即可。

### ✅ 决策

按推荐**方案 D + D1**走。微调：编排决策的 `detail` 中记 task 字段的**前 200 字截断**（与便签墙 `MAX_NOTE_CHARS` 对齐），加 `task_hash`（SHA256）供全文关联（全文在 journal 的 `run_plan` 事件中）。

---

## 议题三：因果追溯模型

### 问题

并行扇出时，扁平时间线无法回答：「run C 的输入来自哪些上游？CEO 的哪次 replan 导致了 run D？」需要时间线之外的**因果结构**。

### 备选方案

| 方案 | 做法 | 查询方式 | 优点 | 缺点 |
|---|---|---|---|---|
| **A. 扁平时间线 + 元数据** | 每事件带 `execution_id` / `run_id` / `parent_run_id` / `turn_id` | 按 run 过滤 + 时间排序 | 实现极简；与现有 SSE payload 一致 | 并行兄弟间的「依赖产出」需二次 join |
| **B. DAG 级因果图** | 显式存储 `cause_event_id → effect_event_id` 边 | 图遍历 | 因果表达最强 | **新存储模型**；与 `depends_on` 重复；写入点分散 |
| **C. 混合：扁平事件 + 运行时重建** | 审计表存 A；查询时用 `depends_on` + `parent_run_id` + journal 中的 `run_plan` 重建因果树 | 时间线 + 按需图展开 | **复用已有数据结构**；GraphView 已消费 run 树 | 复杂查询需应用层组装；跨 turn 因果 🗂️ 需定义边界 |

### 因果重建算法（方案 C 概念）

```
1. 取 turn 内所有 audit events（按 ts 排序）→ 时间线视图
2. 取 journal 的 run_plan / run_completed → 得到 DAG 边（depends_on）
3. 用 parent_run_id 建嵌套委派树（CEO → worker → sub-worker）
4. 注入类事件（run_context / pass_through）标记 source_run_ids[]
5. 合并为「Run 树 + 依赖边 + 注入边」→ 供 GraphView / 审计 API 消费
```

**跨 turn 因果** 🗂️：MVP 限定在**单回合**（同一 `message_id` / `turn_id`）；跨回合「revise 唤回上一轮的 worker」通过 `run_id` 字符串关联（`RunSessionRow`），不建跨 turn 边。

### **推荐：方案 C**

**理由**：

1. `RunSpec.depends_on`、`parent_run_id`、`execution_id` 已在 [`runtime/runs/builder.py`](/apps/server/agentcore/runtime/runs/builder.py) 与 [`runtime/events/run.py`](/apps/server/agentcore/runtime/events/run.py) 落地——**不新增因果图存储**符合补丁绊线。
2. 前端 **GraphView** 已投影 run 树；审计查询与图视图**同源**，避免两套语义。
3. 方案 B 的显式边在「注入」场景仍要特殊处理（pass_through 不是 plan 边），最终仍会退化成混合。

### ✅ 决策

按推荐**方案 C**走：扁平事件 + 运行时重建，与 GraphView 同源。无调整。

---

## 议题四：审计数据模型

### 问题

审计数据存哪里、schema 如何设计、与 `Conversation` / `Turn` / `RunState` 如何关联、如何索引才能支撑议题一的查询目标？

### 核心实体：`agent_audit_events`（提议）

```text
agent_audit_events
├── id              UUID PK
├── user_id         UUID INDEX        -- 多租隔离（owner-scoped）
├── conversation_id UUID INDEX
├── turn_id         UUID INDEX        -- == assistant message_id
├── trace_id        VARCHAR(32) INDEX -- 与 logs / cost_events  join
├── execution_id    VARCHAR(64) INDEX -- 同一次 delegate 批次
├── run_id          VARCHAR(128) INDEX -- 可为空（回合级事件如 delegate 规划）
├── parent_run_id   VARCHAR(128)      -- 嵌套树
├── seq             INT               -- turn 内单调序（可与 journal seq 对齐或独立）
├── category        VARCHAR(32) INDEX -- orchestration | tool | approval | comm | state | failure | permission
├── action          VARCHAR(64) INDEX -- 如 delegate.plan / tool.file_write / approval.granted
├── actor_kind      VARCHAR(16)       -- captain | member | system
├── actor_run_id    VARCHAR(128)      -- 谁干的
├── target_type     VARCHAR(32)       -- file | tool | run | note | interaction
├── target_ref      VARCHAR(512)      -- 路径 / tool_call_id / note_id（非全文）
├── outcome         VARCHAR(16)       -- ok | denied | failed | skipped
├── detail          JSONB             -- 结构化摘要（禁止密钥 / 全文正文）
├── created_at      TIMESTAMPTZ INDEX
└── (无 updated_at — append-only)
```

### 与现有模型的关系

| 现有实体 | 关系 | 审计表如何使用 |
|---|---|---|
| `Conversation` / `Message` | 1:N | `conversation_id` / `turn_id` 外键语义（app-level，无 DB FK） |
| `TurnJournalRow` | 投影源 | 审计写入可**源自** journal 允许列表事件的二次投影，或运行时钩子直写 |
| `RunSessionRow` | 可选 join | `revise` 续跑时 `run_id` 关联 transcript |
| `CostEvent` | 引用 | 同 `run_id` join，不重复 token |
| `TurnMetricsRow` | 互补 | metrics = 回合汇总；audit = 步骤明细 |
| `AdminAuditLog` | 无关 | 人工治理 vs Agent 行为，**分表** |

### 索引策略

| 查询模式 | 索引 |
|---|---|
| 用户「本对话发生了什么」 | `(conversation_id, created_at)` |
| 运营时间窗聚合 | `(created_at, category, action)` 或 BRIN on `created_at` 🗂️ |
| 按 run 归因 | `(run_id)` |
| 按文件查「谁写的」 | `(target_type, target_ref)` partial where `target_type='file'` 🗂️ 需规范化路径 |
| 日志串联 | `(trace_id)` |

### 备选方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 扩展现有 turn_journal** | 加 `audit_meta` 列 | 无新表 | journal 已承担回放；混入审计字段污染 fold 契约 |
| **B. 仅写日志文件** | structlog 旁路 | 零 schema | 无法做用户-facing 查询；prod 可能无文件 |
| **C. append-only 专表** | `agent_audit_events` | 职责清晰；可独立留存策略 | 多一张表要维护投影一致性 |

### **推荐：方案 C（append-only 专表，与业务表分离）**

**理由**：

1. 与 [`AdminAuditLog`](/apps/server/agentcore/db/models/admin_audit.py) 模式一致——**append-only 审计表**已是项目惯例。
2. `turn_journal` 的契约服务于**前端 fold 回放**（见 [`执行引擎架构设计.md` §8.3](/docs/03-AI核心/执行引擎架构设计.md)），不宜叠加运营索引与合规字段。
3. 独立表可设**更长的留存 TTL** 而不影响 journal 清理策略。

### ✅ 决策

按推荐**方案 C（append-only 专表）**走。三项 schema 微调：

1. **去掉 `actor_run_id` 字段**——用 `actor_kind` + `run_id` 推导，因为在一个 run 内 actor 就是该 run 的 agent。
2. **`seq` 独立编号**（不与 journal seq 对齐）——审计是 journal 的子集投影，独立编号更干净；需关联时用 `trace_id` + `created_at` join。
3. **`target_ref` 存工作区相对路径**（与 `files_touched` / `resolve_safe_path` 一致），不存绝对路径。

---

## 议题五：事件采集架构

### 问题

审计事件从哪里、以何种方式写入——直接影响性能、可靠性与与 journal 的一致性。

### 备选方案

| 方案 | 采集点 | 耦合度 | 吞吐 | 一致性 |
|---|---|---|---|---|
| **A. SSE 发射点旁路同步写** | `EventSink.emit` 内直接写 DB | 高 | 中（阻塞 emit 路径） | 与 journal 最强一致 |
| **B. 独立审计中间件/装饰器** | `AuditRecorder` 订阅 `Fact` / 钩子接口；由 `record_turn_fact` 或专用 `audit.record()` 调用 | 中 | 中 | 需明确与 journal 的先后顺序 |
| **C. 异步队列** | emit → 内存队列 → 批量写 | 低 | 高 | 可能丢事件（进程崩溃） |

### 推荐落点（方案 B 细化）

```
runtime/audit/
├── recorder.py      # AuditRecorder.record(event) — 纯 append
├── projector.py     # 从 Fact / SSEEvent 映射为 AgentAuditEvent
└── hooks.py         # 注册到 engine / runs / approvals 的窄回调

写入时机（与 journal 对齐）：
1. journal 类事件：record_turn_fact 成功后调用 AuditRecorder（同 barrier 之后）
2. 非 journal 但需审计的事件（如 approval 细节）：ApprovalGate.resolve 时直写
3. 编排决策：delegate/replan 工具 execute 返回前写（不依赖 SSE）
```

**失败语义**：审计写入失败 **不得阻断** 用户回合（与 `turn_metrics` / `cost_events` 同铁律）——记 `audit.degraded` 日志，内存计数告警。

### **推荐：方案 B**

**理由**：

1. 方案 A 把 DB I/O 塞进 `emit` 热路径，违背 EventSink 的「背压只对 delta」设计。
2. 方案 C 对合规场景有丢事件风险，需 WORM / 队列持久化才安全——**过度工程 for MVP**。
3. 方案 B 与现有 **`Fact` + `record_turn_fact` barrier**（[`sink.py`](/apps/server/agentcore/runtime/events/sink.py)）同构，可复用「先落盘再 SSE」纪律的子集。

### ✅ 决策

按推荐**方案 B**走。补充约束：

- 审计写入与 journal 写入是「**先 journal 后审计**」的偏序，非事务绑定。journal 成功但审计失败不阻断回合。
- 降级计数应出现在 `turn_metrics` 的 **`audit_drops`** 字段里，运营看板可发现审计采集健康度。

---

## 议题六：跨 Agent 数据流审计

### 问题

多 Agent 协作中，数据经 **pass_through 注入**、**便签墙广播**、**文件产物指针**在 Agent 间流转。审计是否记录内容？如何在隐私与可观测性间取舍？

### 数据流类型

| 流类型 | 机制 | 敏感级别 | 现有记录位置 |
|---|---|---|---|
| 上游 → 下游注入 | `result_handling=pass_through` / `summarize` | 高（可能含 PII） | `run_context` SSE；下游 transcript |
| 便签墙 | `post_note` / `amend_note` | 中（≤200 字） | journal `team_note_posted` |
| 文件指针 | `files_touched` / 工作区清单 | 低（路径） | tool result + CEO 收尾清单 |
| CEO 播种 | `delegate.seed_notes` | 中 | journal |

### 备选方案

| 方案 | 记录内容 | 隐私 | 存储成本 | 排障价值 |
|---|---|---|---|---|
| **A. 记录全文** | 注入块、便签正文 | 差 | 极高 | 最高 |
| **B. 仅记录流向元数据** | from_run / to_run / kind / byte_size / path 列表 | 好 | 低 | 中高 |
| **C. 哈希 + 可选采样** | 内容 SHA256 + 运营采样存全文 | 中 | 中 | 高（取证） |

### **推荐：方案 B（MVP）；方案 C 作 Phase 3 合规选项**

**理由**：

1. 内容已在 `turn_journal` / `Message` / 工作区文件中——审计再存全文是**第三副本**，违反最小化原则。
2. 便签墙 `MAX_NOTE_CHARS=200` 可在 `detail` 中保留全文（与协作模式上限一致），**不**扩大 pass_through 注入全文。
3. 流向元数据足以回答用户核心问题：「C 读了 A 的什么」→ `source_run_ids` + `handling=pass_through` + `size_bytes`；若需看内容，UI 引导至 run 详情（已有）。

**审计记录示例（注入）**：

```json
{
  "action": "context.inject",
  "detail": {
    "source_run_ids": ["del_abc_1", "del_abc_2"],
    "target_run_id": "del_abc_3",
    "handling": "pass_through",
    "size_bytes": 48200,
    "truncated": true,
    "file_pointers": ["report.md"]
  }
}
```

### ✅ 决策

按推荐**方案 B**走（MVP 记流向元数据不记内容）。确认便签墙 ≤200 字全文作为**唯一例外**。方案 C（哈希 + 采样）仍作 Phase 3 选项。

---

## 议题七：权限传播审计

### 问题

多 Agent 树中权限如何声明、如何传播、如何实际执行——三者可能不一致。审计需记录「生效权限」，而非仅 CEO 的初始声明。

### 需记录的权限事件

| 事件 | 触发点 | 记录字段 |
|---|---|---|
| **工具白名单收窄** | `delegate` task.`tools` 非空 | 声明子集 vs 实际 `offer_tools` |
| **嵌套委派授权** | `can_delegate=true` | `parent_run_id`、depth、子 `execution_id` |
| **审批授权** | `ApprovalGate.authorize` / resolve | tool、scope（once / turn / file_class）、decision、**是否 sweep 兄弟** |
| **审批超时** | timeout → deny | interaction_id、elapsed_ms |
| **工具熔断** | `LoopController` 停用工具 | run_id、tool_name、failure_count |
| **写冲突守卫** | `WriteCoordinator` 拒绝 | path、claiming_run_id |
| **嵌套树授权继承** | worker 继承 CEO 门 | turn_id、inherited_from（captain run） |

### 备选方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 仅记录审批** | 只管 GRANTABLE | 简单 | 丢失 tools 收窄与 delegate 传播 |
| **B. 记录声明 + 生效快照** | 每个 run 开局写一条 `permission.effective` | 可证明 least-privilege | 每 run 一行，略冗余 |
| **C. 仅记录偏差** | 声明 vs 生效不一致时才写 | 省存储 | 合规场景需「证明了什么权限」而非「证明了什么出错」 |

### **推荐：方案 B（每个 run 一条生效快照）+ 审批/偏差事件明细**

**理由**：

1. [`安全权限与治理.md` §三](/docs/05-平台与运维/安全权限与治理.md) 明确「整棵 DAG 共享审批」——审计必须能证明 **子 worker 的工具调用在同一 turn 授权下**。
2. `tools` 缺省全量 vs 收窄是曾导致「worker 不落盘」的正确性 bug 接缝——**生效快照**对排障价值极高。
3. 每 run 一条快照在 MAX 10 steps × depth 2 规模下可接受（~20 行/回合）。

### ✅ 决策

按推荐**方案 B**走（每 run 生效快照 + 审批明细）。7 类权限事件分优先级：

- **MVP（Phase 1）**：`permission.effective` 快照（每 run）、`approval.granted/denied/timeout`、嵌套 `can_delegate` 授权
- **Phase 2**：工具熔断（LoopController 停用）、写冲突守卫拒绝、sweep 兄弟批量放行明细

---

## 议题八：查询与可视化

### 问题

不同受众需要什么查询能力？与现有 GraphView 如何分工？

### 受众需求矩阵

| 查询 | 终端用户 | 平台运营 | MVP |
|---|---|---|---|
| 时间线：「这一回合发生了什么」 | ✅ 叙事序 | ✅ | ✅ 复用 run 详情 + 审计时间线 Tab |
| 归因：「谁写了这个文件」 | ✅ | ✅ | ✅ `target_ref` 反查 |
| 因果：「为什么做这个决定」 | ✅ | ⏳ | 🗂️ Phase 2 图展开 + 编排事件摘要 |
| 聚合：「过去 1h 工具失败数」 | ❌ | ✅ | ✅ admin API |
| 告警：「审批超时率 > 阈值」 | ❌ | ✅ | Phase 2 |
| 导出：「合规包」 | ⏳ | ⏳ | Phase 3 |

### 与 GraphView 的关系

| 层 | 职责 |
|---|---|
| **GraphView**（现有） | 结构可视化：run 树、依赖边、并行波次、状态角标 |
| **审计时间线**（新增） | 叙事可视化：按时间排列的决策 + 副作用 + 审批 |
| **审计归因面板**（新增） | 从文件 / 工具反查 run 链 |

**集成策略**：不重做图——在 GraphView 节点上叠加「审计事件数」角标；点击节点展开**该 run 的审计子时间线**（数据来自 `agent_audit_events` WHERE `run_id=?`）。

### 备选方案

| 方案 | MVP 范围 | 优点 | 缺点 |
|---|---|---|---|
| **A. 仅 admin 后台** | 运营 API + 表格 | 最快 | 用户看不到 |
| **B. 用户对话内轻量 + admin 重** | 对话详情加「活动记录」；admin 聚合 | 对齐议题一推荐 | 前端两处 |
| **C. 独立审计产品页** | 新应用 | 体验完整 | 违背「一受众一应用」的 MVP 纪律 |

### **推荐：方案 B**

**MVP 交付**：

1. **桌面**：对话 run 详情侧栏增加「活动记录」列表（编排 / 写文件 / 审批 / 升级）。
2. **Admin**：[`管理员后台.md`](/docs/05-平台与运维/管理员后台.md) 观测看板增加审计聚合 widget（失败率 / 审批超时 / 嵌套深度分布）。
3. **手机**：Phase 2（「手机 = 桌面 − 能力层」）。

### ✅ 决策

按推荐**方案 B**走。MVP 范围收窄：

- **Phase 1**：桌面 run 详情侧栏「活动记录」列表 + admin 聚合看板 widget
- **Phase 2**：GraphView 节点审计角标（与因果追溯可视化一起做）

API：`GET /conversations/{id}/messages/{mid}/audit`（owner-scoped）+ `GET /admin/audit/summary`

---

## 议题九：存储策略与保留期限

### 问题

审计数据保留多久、存在哪、如何清理、是否与对话生命周期绑定？

### 备选方案

| 方案 | 保留策略 | 优点 | 缺点 |
|---|---|---|---|
| **A. 随对话删除** | 硬删 conversation 时级联删 audit | 隐私最好 | 运营无法做已删对话的事后分析 |
| **B. 固定天数（全局）** | 如 90 天 TTL sweep | 简单可预期 | 不区分对话价值 |
| **C. 分级保留** | 用户可见 30 天；运营聚合表 1 年；合规归档 🗂️ | 成本与需求平衡 | 实现复杂 |
| **D. 同库 vs 独立库** | 审计表在 PG 同实例 vs 独立 OLAP/对象存储 | 独立库易扩展 | 独立库 MVP 过重 |

### 存储位置

| 选项 | 适用阶段 |
|---|---|
| **主库 PG `agent_audit_events`** | Phase 1–2（预估 ≤ 数百行/回合 × 活跃用户） |
| **冷归档对象存储（JSONL 按月分片）** | Phase 3 合规导出 |
| **独立 ClickHouse / BigQuery** | 🗂️ 有真实体量数据后再议 |

### **推荐：B（固定 90 天 TTL）+ 主库 PG；对话删除时级联删 audit 行**

**理由**：

1. 与 `paused_turns` / `run_sessions` 的 7 天 TTL 相比，审计需更长窗口支撑运营——**90 天**是常见默认 🗂️ 可配置。
2. 对话硬删时级联删 audit，对齐 [`安全权限与治理.md` §一](/docs/05-平台与运维/安全权限与治理.md) 用户数据生命周期。
3. 独立库在无真实流量数据前是过度工程；`turn_metrics` 已证明 PG 聚合够用。

**清理实现**：`audit_retention_days` 设置项 + 日级 sweeper（镜像 `session_retention.py`）。

### ✅ 决策

按推荐走但微调清理策略的分期：

- **Phase 1**：主库 PG + 删对话级联删审计行（隐私硬约束）
- **Phase 2**：TTL sweep（90 天默认可配，`audit_retention_days` 设置项 + 日级 sweeper）

理由：级联删是隐私必须，TTL sweep 是成本优化，早期用户量小不紧迫。

---

## 议题十：实施路线

### Phase 1（MVP）— ✅ 已落地（2026-07-06）

| 交付 | 内容 |
|---|---|
| Schema | `agent_audit_events` 专表（去掉 `actor_run_id`，`seq` 独立编号，`target_ref` 工作区相对路径） |
| 采集 | `AuditRecorder`，先 journal 后审计偏序，降级计数入 `turn_metrics.audit_drops` |
| 事件范围 | 编排决策（task 前 200 字 + hash）+ 副作用工具 + 审批 + Agent 间通信（流向元数据 + 便签全文）+ 状态/失败。不记只读工具 |
| 权限 | 每 run `permission.effective` 快照 + 审批 granted/denied/timeout + 嵌套 `can_delegate` 授权 |
| API | `GET /conversations/{id}/messages/{mid}/audit`（owner-scoped）+ `GET /admin/audit/summary` |
| 前端 | 桌面 run 详情「活动记录」+ admin 看板审计聚合 widget |
| 清理 | 删对话级联删审计行 |
| 测试 | 集成测试：delegate 回合 → 断言审计行数与关键 action |

**不在 Phase 1**：只读工具审计、GraphView 角标、告警、合规导出、手机端、TTL sweep。

### Phase 2 — 因果追溯 + 可视化 + 告警

> **分批决策（2026-07-06 第二轮）**：Phase 2 拆两批实施。第一批 = 复用现成点位的纯增量（因果 / 角标 / 归因反查 / 权限明细 / TTL / 测试补齐 + Phase 1 缺口部分补齐）；第二批 = 看板增强、只读 D2 开关（手机端另行立项，见下）。

**第一批（⏳ 实施中）**：

| 交付 | 内容 |
|---|---|
| 因果 | 审计 API 返回 `causal_graph`（复用 `depends_on` + 注入边），query 开关按需返回 |
| 可视化 | GraphView 节点审计角标；点击沿用 drill-in → run 详情「活动记录」，不建新面板 |
| 查询 | 按 `target_ref`（文件路径）反查：`GET /conversations/{id}/audit/file?path=…`（owner-scoped）+ 桌面入口 |
| 权限 | 工具熔断（`permission.tool_disabled`）、写冲突守卫拒绝（`permission.write_conflict`）、sweep 兄弟批量放行明细（`approval.swept`） |
| Phase 1 缺口补齐 | ✅ 补 checkpoint 挂起/恢复 + 重试明细（attempt 序号）；**`approval_required` 不补**——与 resolved 一一对应，journal 已有 |
| 清理 | TTL sweep（90 天可配，`audit_retention_days` + 日级 sweeper，镜像 `session_retention.py`） |
| 测试 | 补 `/admin/audit/summary` 集成测试 + 级联删专项测试 |
| preview | `#/preview` 离线回放下审计 UI 空态兜底（不再显示「加载失败」） |

**第二批（⏳ 待启动）**：

| 交付 | 内容 |
|---|---|
| 运营 | ✅ 决策（2026-07-06 第二轮）：**看板增强而非告警引擎**——summary 加失败率/审批超时率，widget 超阈值高亮，阈值为设置项；不建规则 CRUD / 通知渠道（无真实数据，阈值只能是假设值，通知渠道无需求验证） |
| 只读审计 | feature flag `audit_read_tools=true`（议题二 D2），默认关 |

**手机端**：✅ 决策（2026-07-06 第二轮）：本阶段**不做**——手机端无 run 详情容器（TeamView 为不可点击列表），等手机端 run 详情交互立项后跟进（对齐「手机 = 桌面 − 能力层」）。

**边界知情项**：写冲突审计只覆盖实际走 `WriteCoordinator.claim()` 的路径（当前 `file_write` / `file_append`）；`str_replace` / `file_delete` / `file_move` 未走 claim——是否扩大 WriteCoordinator 覆盖属行为变更，**另立议题**，不混入审计。

### Phase 3 — 合规审计 + 导出 + 高级分析

| 交付 | 内容 |
|---|---|
| 合规 | WORM 或签名链 🗂️、法定格式导出 |
| 留存 | 分级保留 / 冷归档 |
| 分析 | 跨用户报告（匿名聚合）、异常检测；哈希 + 采样（议题六方案 C） |
| 协同 | 与 §九 其他待定项联动（见下） |

### 与 §九 其他待定项协同

| §九 议题 | 与审计的关系 | 协同方式 |
|---|---|---|
| **权限模型** | RBAC 决定「谁能看审计」 | 审计 API 走 owner-scoped + admin 门控；细粒度 RBAC 后加 |
| **滥用防护** | 审计是检测的数据源 | Phase 2 告警消费 audit 聚合；注入检测仍靠现有提示词守卫 |
| **数据与合规** | 留存 / 导出 / 跨境 | Phase 3 对齐 GDPR/数安法 🗂️ |
| **审计与追溯** | 本文 | 落地后迁入 §五 或新 §「Agent 行为审计」 |

### 里程碑与依赖

```text
Phase 1 ──► 不依赖新权限模型；依赖 trace_id 现有字段
Phase 2 ──► 依赖 GraphView 结构稳定；admin 看板扩展
Phase 3 ──► 依赖企业客户需求验证 🗂️
```

### ✅ 决策

Phase 1 交付清单以本节上表为准（已按议题一至九决策修正）；Phase 2 增量含因果追溯 API + GraphView 角标 + 只读工具 D2 开关 + TTL sweep + 熔断/写冲突/sweep 权限明细 + **看板增强（非告警引擎，2026-07-06 第二轮）**；Phase 3 含合规导出 + WORM/签名链 + 分级保留 + 哈希采样 + 跨用户匿名分析。Phase 2 分批与手机端决策见上节。

---

## 开放问题

1. **单 Agent 纯聊天**是否写入 audit（category=tool 仅 GRANTABLE）——还是 delegate 回合才写？ → **✅ 决策：MVP 不写，仅 delegate 回合**（对齐议题二方案 D 范围）
2. **只读工具审计**（D2）是否作为企业版开关——默认开还是关？ → **✅ 决策：Phase 2 feature flag，默认关**
3. **审计 API 是否进入 conformance**——还是纯运营面、不进三端 fold？ → **✅ 决策（2026-07-06 第二轮）：不进**。审计是 REST 拉取面，非 SSE fold 契约；`#/preview` 离线回放对审计 UI 做空态兜底即可
4. **`trace_id` 跨链路统一**（[`执行引擎架构设计.md` §三](/docs/03-AI核心/执行引擎架构设计.md) ⏳）是否作为 Phase 1 前置？ → **✅ 决策：Phase 1 不前置，用现有 trace_id**（对齐议题十依赖关系）

---

## 文档结论

多 Agent 协作审计的**核心设计选择**（2026-07-06 讨论确认）：

| 议题 | 决策 |
|---|---|
| 受众 | MVP 服务终端用户 + 平台运营；合规 Phase 3 |
| 粒度 | 方案 D + D1：编排（task 前 200 字 + `task_hash`）+ 副作用 + 审批 + 通信 + 状态/失败；只读 Phase 2 feature flag |
| 因果 | 扁平事件 + 运行时重建（与 GraphView 同源） |
| 模型 | append-only `agent_audit_events` 专表；无 `actor_run_id`；`seq` 独立编号；`target_ref` 工作区相对路径 |
| 采集 | 独立 `AuditRecorder`；先 journal 后审计偏序；降级计数入 `turn_metrics.audit_drops` |
| 数据流 | 流向元数据；便签墙 ≤200 字全文为唯一例外；哈希采样 Phase 3 |
| 权限 | Phase 1：每 run 生效快照 + 审批 granted/denied/timeout + 嵌套 `can_delegate`；Phase 2：熔断 / 写冲突 / sweep 明细 |
| 查询 | Phase 1：桌面「活动记录」+ admin 聚合 widget + 双 API；Phase 2：GraphView 角标 |
| 留存 | Phase 1：删对话级联删；Phase 2：90 天 TTL sweep（可配） |
| 路线 | 三阶段；Phase 1 可独立交付（见议题十表） |

逐项决策后，将结论迁入 [`安全权限与治理.md`](/docs/05-平台与运维/安全权限与治理.md) 与 [`执行引擎架构设计.md`](/docs/03-AI核心/执行引擎架构设计.md)，本文退役。
