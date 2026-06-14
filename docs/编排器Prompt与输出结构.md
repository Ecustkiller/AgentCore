# 编排器 Prompt 工程与输出结构设计

> **状态**：已确定方向（输出结构和流式策略）；system prompt 细节待迭代

---

## 核心定位（2026-06-14 修订：CEO 主 Agent 模型）

编排能力归属于一个**会话型「CEO」主 Agent**——它既是**唯一对话入口与声音**，也是**团队规划大脑**。CEO 直接与用户对话、可来回澄清；当任务确需团队时，它**下达指令**（结构化协作计划），驱动执行引擎调度多个 Agent 并行/串行工作，并**用自己的声音收尾汇报**（合成器角色并入 CEO）。

> 这是对「聊天优先 + 按需编排」的统一收敛：把原先的「聊天 Agent + 隐形编排器 + 合成器」三套人格合并为**一个 CEO**，消除职责重叠与人格切换，并让编排器获得「先澄清再下达」的能力。完整讨论与决策见 `规划/编排器重定位-讨论与规划.md`。
>
> **底线不变**：合并的是「对用户的身份/声音」，不是「每轮都跑重规划」。CEO 默认走快的会话档，简单对话直接作答（零编排开销）；「组团/下计划」是按需触发的能力。
>
> 现状：代码仍是「聊天 Agent（`pipeline.py`）+ 独立编排器（`planner.py`）+ 合成器（`runs.py`）」的分离接线，CEO 统一为已确认的下一步重构，尚未落地。

### 职责边界（CEO）

```
✅ 与用户直接对话、必要时来回澄清（D2）
✅ 简单请求直接作答（承袭聊天优先，零编排开销）
✅ 理解意图、分解任务、决定 Agent 数量与角色、分配工具集
✅ 定义步骤间依赖关系（驱动并行/串行）、设定检查点
✅ 在检查点审视中间结果并调整计划
✅ 团队跑完用自己的声音收尾汇报（D3）
❌ 复杂任务的内容生产交给 workers，CEO 不亲自下场堆产出
❌ 重规划只在按需触发时支付，绝不让简单对话背上规划税
```

### 实现方案 ✅ 已确定

**自研编排器，不依赖 LangGraph / CrewAI 等第三方编排框架。**

| 设计点 | 决策 |
|--------|------|
| 编排器定位 | CEO 主 Agent 的「按需规划能力」：CEO 既对话又规划；简单请求直接答，复杂任务才下达全景计划 |
| 调度模式 | 检查点模式：规划后在关键节点轻量审视中间结果，决定是否调整 |
| 输入 | 用户请求 + 可用工具清单 + 行为模板（如有）+ 项目/会话上下文摘要 |
| 输出 | 结构化 JSON 协作计划（见 §二） |

**为什么自研（被否决：LangGraph 等框架）：**

1. 编排器是 AgentCore 的核心竞争力和产品壁垒，必须完全掌控
2. 第三方框架的抽象与「Agent 团队管理」心智模型不完全匹配
3. 自研可针对产品需求深度定制，不受框架约束
4. 避免框架锁定风险

### 检查点触发条件

| 触发条件 | 编排器行为 |
|----------|-----------|
| Agent 完成一个阶段 | 审视输出摘要，确认是否继续下一步 |
| Agent 报告失败 / 异常 | 重新规划或分配备用 Agent |
| Agent 请求协助 | 决定是否增加新 Agent |
| 用户主动干预 | 重新规划 |
| 并行任务全部完成 | 触发汇总阶段 |

### 聊天优先 + 按需编排（CEO 统一身份）✅ 已确定（2026-06-14 修订）

入口即 **CEO 主 Agent**（默认走快的 `chat` 档），它直接拥有并回复对话。只有当 CEO 判断某请求**确实需要一个团队**（多视角并行、设计→实现→测试流水线、辩论/对比）时，才**下达全景计划**、执行 DAG，并由 CEO 自己收尾汇报。简单对话由同一个 CEO 直接作答，不经任何重规划。

| 场景 | 路径 | 用户感知 |
|------|------|---------|
| 简单对话 / 问答 / 单点工具 | CEO 直接流式回答（零编排开销） | 首字即时，体验同 ChatGPT |
| 需要团队的复杂任务 | CEO 下达计划 → 多 Agent DAG → CEO 收尾汇报 | 协作面板展开，展示完整分工；全程一个声音 |

升级由模型自决：CEO 每轮都在，自己判断要不要组团；升级时给用户明确的视觉信号（任务卡片 + 图视图）。误判时优雅降级——若判定任务实为单 Agent，直接由 CEO 作答，不空转组团。

→ 见代码：`runtime/pipeline.py`（聊天入口）、`tools/builtin/assemble_team.py`（按需编排工具 + 降级）、`runtime/planner.py`（团队规划）、`runtime/runs.py`（DAG 执行）

> **被否决：编排器是唯一入口（无前置分类器，每轮必经编排器）。** 原方案让每条消息（哪怕「你好」）都先付一次完整编排器往返，实测对简单输入也有 ~15s 首字延迟；叠加「编排器强烈偏向 single_agent」后，95% 对话的编排纯属高频聊天的「税」。改为「聊天优先 + 按需编排」后，编排开销只在真正需要团队时支付，对齐 Claude Code（Agent/Task 工具）、OpenAI Agents SDK（agents-as-tools）的行业范式。原方案「避免两套决策逻辑不一致」的诉求，改由聊天 Agent 统一承担「每轮判断是否升级」来满足，不再需要独立前置编排。

---

## 一、编排器输入结构

编排器的输入由 planner 在调用前组装为一段文本提示（用户请求 + 最近对话摘要 + 可用工具清单 + 约束），而非传入结构化 JSON。

→ 见代码：`apps/server/agentcore/runtime/planner.py`（`_build_messages` 组装、`_summarize_history` 历史摘要）

下表为输入的概念字段：

### 字段说明

| 字段 | 来源 | 作用 |
|------|------|------|
| `user_request` | 用户原文 | 编排器理解意图的基础 |
| `recent_history` | 当前会话最近对话（工作记忆，`_summarize_history` 截取最近数条） | 让编排器保有当前对话上下文 |
| `available_tools` | 工具注册表 | 编排器只能分配已有工具 |
| `constraints` | 系统配置/用户设置 | 硬性限制 |
| `context.project_context` | 项目索引/摘要 | 让编排器了解工作环境（MVP 未注入） |

---

## 二、编排器输出结构

编排器的输出是一个结构化协作计划，直接驱动执行引擎。

### 数据结构与 Schema

计划的类型化数据结构（`OrchestratorPlan` / `PlannedAgent` / `PlannedStep` / `PlannedCheckpoint` / `OutputStrategy`）与容错解析（始终产出合法计划、无环校验）已落地；给 LLM 的 JSON Schema 内嵌在编排器 system prompt 中：

→ 见代码：`apps/server/agentcore/runtime/plan.py`（数据类 + `parse_plan` + `_assert_acyclic`）、`runtime/planner.py`（`_PLANNER_SYSTEM_PROMPT` 内的输出 JSON Schema）

字段语义与设计理由见 §三；各字段的取值约束（如 `model_preference ∈ fast/strong`、`merge_type ∈ direct/sequential/merge/compare`、最多 5 agent / 20 step）由 `plan.py` 解析时强制。

---

## 三、关键字段设计决策

### 3.1 `plan_type` — 计划类型

| 值 | 含义 | UI 行为 |
|---|---|---|
| `single_agent` | 单 Agent 直接处理 | 不显示任务卡片，类 ChatGPT 体验 |
| `multi_agent` | 多 Agent 协作 | 显示任务卡片 + 图视图可用 |

### 3.2 `agents[].model_preference` — 模型偏好

编排器不指定具体模型，只表达能力需求，由运行时映射到具体模型（此处使用 fast/strong 两档抽象，运行时映射为 DeepSeek V4）：

| 值 | 含义 | 运行时映射示例 |
|---|---|---|
| `fast` | 速度/成本优先，简单机械子任务 | DeepSeek V4 Flash（非思考） |
| `strong` | 质量优先，复杂子任务 | DeepSeek V4 Pro（thinking；暂走 Flash） |

> 现状：`strong` 当前临时映射为 Flash（thinking，测试期降本，`llm/config.py` `_STRONG_MODEL` 单点翻转），非 Pro。

设计理由：
1. 解耦编排器与具体模型，模型更新不需改编排逻辑
2. 用户可覆盖映射（如全部用 strong）
3. 未来可做智能路由（根据负载、成本、性能自动选择）

### 3.3 `steps[].depends_on` — 依赖关系

这是实现串行/并行的关键：

- `depends_on: []` → 可立即启动（与其他无依赖步骤并行）
- `depends_on: ["step_1"]` → 等 step_1 完成后才启动
- `depends_on: ["step_1", "step_2"]` → 等两个都完成

执行引擎通过解析依赖关系自动确定并行度，无需编排器显式声明"这是并行的"。

### 3.4 `checkpoints` — 检查点设置原则

编排器根据以下启发式决定是否设置检查点：

| 条件 | 设检查点 | 不设 |
|------|---------|------|
| 后续步骤强依赖前序输出 | ✅ | |
| 决策方向有歧义 | ✅ | |
| 步骤独立且低风险 | | ✅ |
| 简单任务（单 Agent） | | ✅ |

### 3.5 `output_strategy.merge_type` — 输出汇总策略

| 值 | 含义 | 何时使用 |
|---|---|---|
| `direct` | 单 Agent 输出直接展示给用户 | 单 Agent 场景 |
| `sequential` | 按步骤顺序拼接各 Agent 输出 | 串行工作流 |
| `merge` | 需要一个汇总 Agent 合并多路结果 | 并行工作流的最终整合 |
| `compare` | 并列展示多路结果并突出差异 | 辩论/审查范式 |

---

## 四、流式编排实现

根据已确定的「流式编排」策略（见上文「聊天优先 + 按需编排」），编排器输出应可被增量解析。

> 现状：当前 planner 用非流式 `llm.complete()` 一次性产出完整计划再解析（`runtime/planner.py` `make_plan`），下述增量解析 / 增量触发尚未实现，属规划中的优化。
>
> 重要：编排器已**不在每轮对话的热路径**上——它只在聊天 Agent 调用 `assemble_team` 后才运行。因此其首 token 延迟只影响「确实需要团队」的请求，简单对话完全不经过它（首字即时）。下表延迟目标仅针对团队场景。

### 输出字段顺序

编排器被指导按以下顺序输出字段，使解析器能尽早触发动作：

```
1. plan_type          → UI 立即决定是否显示任务卡片
2. task_summary       → UI 显示任务标题
3. agents[]           → UI 逐个显示 Agent 行
4. steps[]            → 执行引擎逐个解析，无依赖的步骤立即启动
5. checkpoints[]      → 注册到执行引擎
6. output_strategy    → 注册到汇总器
7. constraints        → 注册到调度器
```

### 增量解析器行为

```
接收到 plan_type = "single_agent"
    → UI: 不显示任务卡片
    → 执行引擎: 准备单 Agent 模式

接收到 agents[0] 完整
    → UI: 显示第一个 Agent 行（如果是 multi_agent）
    → 执行引擎: 初始化 Agent 实例

接收到 steps[0] 且 depends_on = []
    → 执行引擎: 立即启动该 Agent 执行
    → （不等完整计划生成）
```

### 感知延迟控制

| 阶段 | 目标延迟 | 手段 |
|------|---------|------|
| 调用 `assemble_team` → 计划首 token | 思考档下不强保 <500ms（仅团队场景；简单对话不经此路径） | 编排器 Flash 思考档（`reasoning_effort=max`，规划质量优先） |
| 首 token → UI 响应 | < 100ms | 流式解析 + 增量渲染 |
| 计划完成 → Agent 启动 | < 200ms | 不等完整计划，增量触发 |

---

## 五、检查点审视（Checkpoint Review）

检查点触发时，编排器被再次调用，但输入和输出与初始规划不同。

> ⚠️ 现状与本节设计有差异：MVP **未实现**「编排器 LLM 审视」。实际在检查点处直接挂起并向**用户**请求决策（approve / adjust / stop），无 continue/escalate 的 LLM 自动判定——见 `runtime/runs.py`（`handle_checkpoint`）、`runtime/interactions.py`。本节的 LLM 审视模型保留为设计方向，是否落地待定（见 §九）。

### 检查点审视输入

```json
{
  "review_type": "checkpoint",
  
  "original_plan": { "...完整的初始计划..." },
  
  "completed_step": {
    "step_id": "step_1",
    "agent_id": "agent_1",
    "output_summary": "设计了 4 个 API 端点：POST /auth/login, POST /auth/register, POST /auth/refresh, GET /auth/oauth/callback。采用 JWT + refresh token 方案。",
    "artifacts": ["docs/api_design.md"],
    "metrics": {
      "duration_ms": 15000,
      "tokens_used": 2300
    }
  },

  "review_focus": "API 端点是否完整，OAuth 流程是否合理",
  
  "remaining_steps": ["step_2", "step_3"]
}
```

### 检查点审视输出

```json
{
  "decision": "continue | adjust | escalate",
  
  "reasoning": "API 设计完整，OAuth 流程合理，可以继续",
  
  "plan_adjustments": null,

  "user_message": null
}
```

#### decision 类型

| 决策 | 含义 | 后续行为 |
|------|------|---------|
| `continue` | 中间结果合格，继续执行 | 自动启动后续步骤 |
| `adjust` | 需要调整计划 | 应用 plan_adjustments，继续执行 |
| `escalate` | 需要用户参与 | UI 展示检查点卡片，等待用户操作 |

#### plan_adjustments 格式（当 decision = "adjust"）

```json
{
  "plan_adjustments": {
    "modify_steps": [
      {
        "step_id": "step_2",
        "new_task": "实现 JWT 登录（暂不做 OAuth，API 设计中 OAuth 方案有待优化）"
      }
    ],
    "add_steps": [
      {
        "id": "step_2b",
        "agent_id": "agent_1",
        "task": "重新设计 OAuth 回调流程，参考 Google OAuth 2.0 最佳实践",
        "depends_on": ["step_2"],
        "expected_output": "修订后的 OAuth 设计"
      }
    ],
    "remove_steps": []
  }
}
```

---

## 六、编排器 System Prompt 结构

### 结构与现状

编排器 system prompt 已落地：角色定义 + 输出 JSON Schema + 决策规则（强烈偏向 single_agent、depends_on 决定并行、工具白名单、model_preference 选择、检查点克制）+ 反例。

→ 见代码：`apps/server/agentcore/runtime/planner.py`（`_PLANNER_SYSTEM_PROMPT`）

> 现状：尚未引入 §六原设计的 few-shot 示例库与 `{schema}`/`{max_agents}` 模板占位，schema 直接内嵌在 prompt 中；待迭代（见 §九）。

### 关键设计原则

1. **偏向简单**：如果不确定需要多少 Agent，优先用少的
2. **工具最小集**：只给 Agent 它真正需要的工具
3. **检查点克制**：只在高价值决策点设置，不要每步都查
4. **角色清晰**：每个 Agent 的目标应不重叠、不遗漏

---

## 七、编排器失败处理

| 失败场景 | 处理策略 |
|---------|---------|
| 输出不可解析 | 重试 1 次（加强格式约束）→ 仍失败则回退 single_agent |
| 输出不合理（如 10 个 Agent） | 重试 1 次（强调约束）→ 仍不合理则回退 |
| 模型不可用 | fallback 到备选模型 |
| 超时 | 中断，回退 single_agent |

回退到 single_agent 是安全的兜底——用户最差也能得到一个普通聊天体验。

→ 见代码：`apps/server/agentcore/runtime/plan.py`（`parse_plan` 容错解析 + `single_agent_plan` 兜底）、`runtime/planner.py`（`make_plan` 的 try/except 兜底）

> 现状：当前实现为「容错解析（丢弃非法 agent/step、校验取值、去悬挂依赖、无环校验）+ 任意失败即回退 single_agent」，尚未实现表中的「重试 1 次」与编排器专用 fallback 模型。

---

## 八、与其他模块的接口

### 编排器 → 执行引擎

```
输入: 结构化计划 JSON
输出: 启动 Agent 实例，建立依赖图，注册检查点
```

### 编排器 → UI 层

```
输入: 一次性产出的完整计划（run_plan SSE 事件；§四 流式增量解析未实现）
输出: 
  - plan_type → 决定是否显示任务卡片
  - agents → 填充任务卡片的 Agent 列表
  - steps → 填充进度信息
  - checkpoints → 注册用户交互点
```

### 执行引擎 → 编排器（检查点触发时）

```
输入: 检查点审视请求（原计划 + 中间结果）
输出: continue / adjust / escalate
```

---

## 九、待定事项

| 议题 | 说明 |
|------|------|
| System prompt 完整内容 | 需要实际调试迭代，初始版本后根据效果优化 |
| Few-shot 示例库 | 需要收集典型场景，构建示例集 |
| 模型选择 | 编排器本身用什么模型（偏向 fast + structured output 好的） |
| 输出 schema 验证 | 是否用 JSON Schema 严格验证，还是宽松解析 |
| 多轮对话中的编排 | 后续消息是否沿用/修改之前的计划 |
