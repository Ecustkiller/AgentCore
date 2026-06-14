# 编排器与 CEO 主 Agent

> **状态**：已确定并落地（CEO 主 Agent + `delegate` 原语）；CEO/worker 的 system prompt 已确立「身份 + 边界」结构，细节（CEO 升级判据 / worker 角色模板）待迭代

---

## 核心定位：CEO 主 Agent 模型

编排能力归属于一个**会话型「CEO」主 Agent**——它既是**唯一对话入口与声音**，也是**团队规划大脑**。CEO 直接与用户对话、可来回澄清；当任务确需团队时，它通过 `delegate` 工具**下达子任务**，驱动执行引擎调度多个 worker 并行/串行工作，并**用自己的声音收尾汇报**（合成器角色并入 CEO）。

> 这是「聊天优先 + 按需编排」的统一收敛：把原先的「聊天 Agent + 隐形编排器 + 合成器」三套人格合并为**一个 CEO**，消除职责重叠与人格切换，并让编排获得「先澄清再下达」的能力。
>
> **底线**：合并的是「对用户的身份/声音」，不是「每轮都跑重规划」。CEO 默认走快的会话档，简单对话直接作答（零编排开销）；「组团/下计划」是按需触发的能力。
>
> → 见代码：`runtime/pipeline.py`（CEO 工具集 = 8 内置工具 + `delegate`）

### 职责边界（CEO）

```
✅ 与用户直接对话、必要时来回澄清（D2）
✅ 简单请求直接作答（承袭聊天优先，零编排开销）
✅ 理解意图、分解任务、决定 worker 数量与角色、分配工具集
✅ 用 delegate 的 depends_on 定义步骤依赖（驱动并行/串行）
✅ 团队跑完用自己的声音收尾汇报（D3，只写简短概览）
❌ 复杂任务的内容生产交给 worker，CEO 不亲自下场堆产出
❌ 重规划只在按需触发时支付，绝不让简单对话背上规划税
```

### 实现方案：自研编排，不依赖第三方框架 ✅ 已确定

| 设计点 | 决策 |
|--------|------|
| 编排器定位 | CEO 主 Agent 的「按需规划能力」：CEO 既对话又规划；简单请求直接答，复杂任务才下达计划 |
| 调度形态 | DAG 波次调度：`delegate` 的 `depends_on` 定形，`WaveScheduler` 逐波驱动 |
| 输入 | 用户请求 + 可用工具清单 + 会话历史（CEO 在 ReAct 循环内掌握） |
| 输出 | CEO 在 ReAct 循环里调用 `delegate(tasks=[…])` 下达子任务（见下「delegate 原语」） |

**为什么自研（被否决：LangGraph / CrewAI 等框架）：** ① 编排是 AgentCore 的核心壁垒，必须完全掌控；② 第三方框架的抽象与「Agent 团队管理」心智模型不完全匹配；③ 避免框架锁定。

### 聊天优先 + 按需编排 ✅ 已确定

入口即 **CEO 主 Agent**（默认走快的 `chat` 档），它直接拥有并回复对话。只有当 CEO 判断某请求**确实需要一个团队**（多视角并行、设计→实现→测试流水线、辩论/对比）时，才调 `delegate` 下达子任务、执行 DAG，并由 CEO 自己收尾汇报。

| 场景 | 路径 | 用户感知 |
|------|------|---------|
| 简单对话 / 问答 / 单点工具 | CEO 直接流式回答（零编排开销） | 首字即时，体验同 ChatGPT |
| 需要团队的复杂任务 | CEO 调 `delegate` → 多 Agent DAG → CEO 收尾汇报 | 协作面板展开，展示完整分工；全程一个声音 |

升级由模型自决：CEO 每轮都在，自己判断要不要组团；误判时优雅降级——不调 `delegate` 即等价单 Agent 直答，不空转组团。

> **被否决：编排器是唯一入口（无前置分类器，每轮必经编排器 LLM）。** 原方案让每条消息（哪怕「你好」）都先付一次完整编排器往返，实测对简单输入也有 ~15s 首字延迟，95% 对话的编排纯属高频聊天的「税」。改为「聊天优先 + 按需编排」后，编排开销只在真正需要团队时支付，对齐 Claude Code（Task 工具）、OpenAI Agents SDK（agents-as-tools）的行业范式。原方案「避免两套决策逻辑不一致」的诉求，改由 CEO 统一承担「每轮判断是否升级」来满足。

---

## 一、`delegate` 原语（D1′ / D2 / D3）

CEO 在自己的 ReAct 循环里调用单一的 `delegate` 工具把一批子任务交给内联 worker——**图由 CEO 在循环里增量声明**，非外部一次性 JSON 计划。

→ 见代码：`tools/builtin/delegate.py`（`DelegateTool`，schema + execute 流程）、`runtime/pipeline.py`（CEO 工具集 = 8 内置工具 + `delegate`）

### 自选粒度（D1′）

`delegate(tasks=[…])` 的 `tasks` 由 CEO 自定批量：

- **一次塞 N 个** = 全景计划（一批声明完整分工）
- **后续再调一次** = 动态委派（按进展追加）

同一工具 / 同一 schema / 同一调度，CEO 自选委派粒度。并行度由**节点的 `depends_on` 数据声明**（无依赖即同波并行），而非靠模型主动发并行 tool call。

### 终态语义：非终态，CEO 收尾（D3 + 决策①）

`delegate` 是**非终态工具**：worker 跑完后，结果交回 CEO 的 ReAct 循环，CEO **用自己的声音**写最终答案（`content_delta`）。

> **决策①**：CEO 只写**一段简短概览**（综述关键结论、串起整体、指引用户看细节），**不复述各 worker 全文**——每个 worker 的完整产出由前端单独展示（run 详情 / 图视图）。这消解了「CEO 重读全文合稿」的开销。
>
> → 见代码：`tools/builtin/delegate.py` 的 `_format_for_ceo`、`runtime/prompt.py` 的 `CHAT_TEAM_CAPABILITY_HINT`（已重写为 `<role>` 团队管理者身份 + `<how_you_work>` 该做/不该做边界，与上文§职责边界对应）。
>
> **被否决：SYNTHESIS 合稿节点**（在 plan 末尾挂一个独立合稿 Agent）。合稿仍是「循环外一趟」，正是 CEO 模型想溶解的形态；`react_loop` 现成支持「工具返回后继续循环」，无需独立节点。

### execute 流程（概念）

```
delegate(tasks) 
  → build_run_plan(tasks)         # tasks → RunPlan（depends_on 定形）；errors 非空则回 CEO 改参重试
  → run_plan SSE 预声明本批节点      # 图即时点亮
  → WaveScheduler.run(plan, executor)  # 逐波调度，run_progress 推进度
  → 各 worker RunState.content 折叠为结构化文本
  → 非终态返回给 CEO → CEO 收尾（content_delta）
```

→ 见代码：`runtime/runs/builder.py`、`runs/wave.py`、`runs/executor.py`（worker 执行器包 `react_loop`）。运行时机制（波次调度、上下文注入、树级并发、取消、用量聚合）详见 [`Agent协作模式.md` §七](Agent协作模式.md) 与 [`执行引擎架构设计.md`](执行引擎架构设计.md)。

---

## 二、关键字段设计决策

`delegate` 每个 task 的字段语义（完整 schema → 见代码 `tools/builtin/delegate.py`）。下表只记录设计理由。

### 2.1 `model_preference` — 模型偏好

CEO 不指定具体模型，只表达能力需求，由运行时映射（fast/strong 两档抽象 → DeepSeek V4）：

| 值 | 含义 | 运行时映射示例 |
|---|---|---|
| `fast` | 速度/成本优先，简单机械子任务 | DeepSeek V4 Flash（非思考） |
| `strong` | 质量优先，复杂子任务 | DeepSeek V4 Pro（thinking；暂走 Flash） |

> 现状：`strong` 当前临时映射为 Flash（thinking，测试期降本，单点翻转）。→ 见代码 `llm/config.py`（`_STRONG_MODEL`、`apply_overrides`）。

设计理由：① 解耦委派与具体模型，模型更新不改委派逻辑；② 用户可覆盖映射；③ 未来可做智能路由。

### 2.2 `depends_on` — 依赖关系（并行/串行的唯一开关）

执行形状是**数据不是模式**：

- `depends_on: []` → 可立即启动（与其他无依赖步骤并行）
- `depends_on: ["a"]` → 等 a 完成后启动
- `depends_on: ["a","b"]` → 等两个都完成

调度器解析依赖自动确定并行度，无需 CEO 显式声明「这是并行的」。→ 见代码 `runs/builder.py`（`_dag_plan` / `_flat_plan`）、`runs/plan.py`（`waves()` Kahn 分层 + 无环校验）。

### 2.3 `result_handling` — 上游产物保真度

下游节点注入上游 `RunState.content` 时的裁剪策略：

| 值 | 含义 | 何时使用 |
|---|---|---|
| `pass_through` | 全文（带硬上限） | 分析/检索→写作链路，须保留金额、法条编号等细节（默认取向） |
| `summarize` | 摘要 | 大扇入合成省 token 的场景 |

> **默认偏全文**：「一律摘要」会丢失关键信息。→ 见代码 `runs/executor.py`（按 `result_handling` 注入 `completed[dep].content`）。执行形状由 `depends_on` 自然落定，无需离散计划类型。

---

## 三、失败处理

| 失败场景 | 处理策略 |
|---------|---------|
| `delegate` 参数非法（无环校验失败、工具未注册、档位非法等） | `build_run_plan` 收集 `errors` 非终态返回 CEO，CEO 改参数重试 |
| 单个 worker 失败 | 按节点 `on_failure`（`skip` / `abort` / `retry`）处理，单 worker 失败不必拖垮整 DAG |
| CEO 判断无需团队 | 不调 `delegate`，直接作答（等价单 Agent，安全兜底） |

→ 见代码：`runs/builder.py`（结构校验 + 错误收集）、`runs/wave.py`（per-node retry + skip 级联 + abort）。CEO 不委派即等价单 Agent 直答，无需独立兜底计划。

---

## 四、检查点与团队预审 ⏳ Phase 2

当前路径不含团队预审（plan_review）与 DAG 检查点审视；Phase 2 以 **preflight 审计 / 契约闸门 / `ask_user` 挂起**回归（统一交互原语）。落地边界见 §五 待定事项与 [`执行引擎架构设计.md` §十八](执行引擎架构设计.md)。

---

## 五、待定事项（Phase 2 及以后）

| 议题 | 说明 |
|------|------|
| CEO / worker system prompt 内容调试 | 「身份 + 边界」结构已落地（CEO `CHAT_TEAM_CAPABILITY_HINT`、worker 自我认知段）；剩余为内容调试：CEO 升级判据、worker 角色模板 |
| Agent 实体化 | Phase 1 worker 为内联角色（`agent_id == run_id`）；Phase 2 收敛到 `agent_id` + `AgentResolver` + 委派白名单 |
| 增量声明优化 | `run_plan` 按 delegate 批次预声明；`run_started` 加 `parent_run_id` / `kind`（嵌套委派可观测） |
| 交互原语回归 | `ask_user` 挂起 / preflight / 契约闸门 |
| 多轮编排 | 后续消息是否沿用/修改之前的委派结果 |
