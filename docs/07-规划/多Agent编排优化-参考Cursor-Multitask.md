# 多 Agent 编排优化：参考 Cursor Multitask Mode

> **状态**：🗂️ 提案（未定稿）
>
> **动机**：Cursor Multitask Mode 在「协调者路由效率」「Worker 自治」「抑制过度拆分」上有值得借鉴的设计理念。本文以 Cursor Multitask 为对照，梳理 AgentCore 当前多 Agent 编排的六个优化方向，每个给出现状分析、目标设计与实施路径。
>
> **前提**：AgentCore 的「CEO 主 Agent + delegate DAG + WaveScheduler」核心架构不变；本文是在既有框架内的增量优化，不是重设计。

---

## 对照模型：Cursor Multitask Mode 核心理念

Cursor 的 Multitask Mode 在多 Agent 协调上有几个鲜明的设计选择：

| # | 设计理念 | 核心做法 |
|---|---|---|
| 1 | **轻量路由优先** | 协调者只做路由决策（"委派还是自己做"），不做深度规划；规划留给 worker |
| 2 | **单一 coherent worker 优先** | 绝大多数请求 = 一个 worker 完成；只有明确独立的顶层工作流才并行 |
| 3 | **Worker 内部自决拆分** | 协调者告知 worker"此任务可并行"，由 worker 自行决定内部拆分方式 |
| 4 | **通知驱动，非轮询** | 协调者委派后释放控制，等通知回来再续；不阻塞等待 |
| 5 | **三档自主度** | Worker 自主修琐碎问题、尝试执行层问题、方案层立即上报 |
| 6 | **前台/后台硬隔离** | 协调者每次 tool call 前自检"是否在做已委派的工作"，是则停 |

---

## AgentCore vs Cursor：范式差异

两者并非同层对比——AgentCore 是「CEO 精细规划 + DAG 波次调度」，Cursor 是「协调者轻量路由 + Worker 全自治」。优化不是替换范式，而是**在 AgentCore 架构内吸收 Cursor 的效率优势**：

| 维度 | AgentCore 当前 | Cursor Multitask | 借鉴方向 |
|---|---|---|---|
| CEO 规划深度 | 精细 DAG（角色、依赖、工具白名单、契约） | 极浅路由（一句话任务描述） | 简单任务降低规划税 |
| 拆分策略 | CEO 主导拆分（`can_delegate` 为 bool 开关） | Worker 自决拆分 | CEO 少拆，Worker 按需自拆（`false` + `auto` 两档） |
| 执行期 CEO 参与 | 波边界监督、replan、收尾综述 | 委派后释放，通知回来再续 | 减少 CEO 阻塞时间 |
| Worker 自主度 | prompt 驱动 + escalate 三档 | 结构化三档策略（`AutonomyPolicy`） | 将自主度提升为可配置策略 |
| 并行度 | MAX_PARALLEL=8，CEO 显式设计 | 默认单 worker，有需要才并行 | 抑制过度拆分 |

---

## 优化一：智能委派决策 — 分档路由，减少不必要编排

> **通俗说**：CEO 接到用户消息后，要先判断「自己答就行」「派一个人干」还是「得拉一支队」——现在这一步全靠提示词，经常判断失误。

### 现状问题

CEO 的「自己做 vs 委派」决策完全靠 prompt 引导。已知问题：
- 运行期 `delegation_nudge`（委派提醒）软护栏 A/B 实测被模型忽略且净负，已移除
- 代码侧只保留硬兜底（循环控制器在异常轮次过多时强制收尾），常态不触发
- CEO 偶尔对中等复杂度任务过度规划（5 分钟规划 + 1 个 worker 执行 2 分钟），或对简单任务不必要地 delegate

### Cursor 的做法

结构化判据，而非纯 prompt：
- **单步即完成** → 不委派
- **需要共享上下文的中等任务** → 一个 coherent worker
- **明确独立的顶层工作流** → 并行 worker
- 判据写在系统逻辑里，不全靠模型遵守

### 目标设计：三档路由策略

在 CEO 的思考循环中引入**结构化路由信号**（不靠额外 LLM 调用、也不只靠散文式提示），帮助 CEO 做出更高效的委派决策：

| 档位 | 信号特征 | 推荐行为 | CEO 动作 |
|---|---|---|---|
| **直答** | 用户请求无产出物、无成规模调查、CEO 已有足够信息 | 直接流式回答 | 正常 ReAct |
| **轻委派** | 有产出物但结构简单（单文件/单模块/单方向调查） | 单 worker，`finalize=true`，minimal spec | `delegate(tasks=[单任务])` |
| **精编排** | 多方向/多依赖/需要 DAG 结构 | 完整 DAG 规划 | 完整 `delegate(tasks=[...])` |

**实现方式**：不是在 CEO 外加分类器（已被否决），而是在 CEO prompt 中将路由判据从散文升级为**结构化决策树 + 示例**，并在 `delegate` 工具的 schema 中增加 `complexity_hint`（`light`/`standard`/`complex`）让模型显式声明——引擎据此裁剪不必要的规划开销：

```
complexity_hint = "light" 时：
  - 跳过 playbook 匹配
  - 默认 finalize=true（省 CEO 合成轮）
  - 不注入便签墙（单 worker 无兄弟）
  - 不注入兄弟感知块
```

### 核心约束

- **不加前置分类器 LLM 调用**——已被否决（每条消息付编排税，见编排器 §聊天优先）
- **不改 CEO 执行路径**——仍是同一个 ReAct 循环
- **`complexity_hint` 只是优化信号**——缺省 = standard，引擎行为不变

### 涉及文件

| 文件 | 改动 |
|---|---|
| `tools/builtin/delegate/tool.py` | schema 加 `complexity_hint` 枚举字段 |
| `tools/builtin/delegate/drive.py` | 据 `complexity_hint` 裁剪 playbook 匹配、便签墙初始化 |
| `runtime/resolve/prompt.py` | CEO 路由判据从散文升级为决策树 |
| `runtime/skills.py` | `team_orchestration_advanced` 补充轻委派指引 |

---

## 优化二：Coherent Worker 优先 — 抑制过度拆分

> **通俗说**：能一个人干完的活，就别拆成三四个人——每多一个人，就多一轮传话、对账和等待。

### 现状问题

CEO 的 `team_orchestration_advanced` skill 提供了「判据双向：过度拆碎与塌缩成一个都是偏差」的指引，但实践中 CEO 倾向过度拆分：
- 一个「改某模块某功能」的任务被拆成 3–4 个 worker（调研、改代码、改测试、检查类型）
- 协调税（便签墙、产物中转、CEO 综述）超过任务本身的复杂度
- 对比 Cursor：相同任务会作为一个 coherent worker 端到端完成

### Cursor 的做法

明确规则：
> "Most small to medium-sized user requests can be completed with a single coherent worker task, i.e. with no foreground problem decomposition."
>
> "Overly decomposing adds coordination cost and latency; decompose only as it helps you confidently and efficiently fulfill the user's request(s)."

### 目标设计：拆分成本意识

**核心原则**：每多拆一个 worker = 额外支付「协调税」（上下文传递 + 便签墙 + CEO 收尾综述 + 产物中转）。只有当拆分带来的并行收益或专业化收益 > 协调税时才值得拆。

**1. Prompt 层：引入「拆分成本」心智**

在 `_CEO_CORE_HINT` 和 `team_orchestration_advanced` 中增加显式的成本意识判据：

```
拆分决策：
- 默认倾向 = 一个 coherent worker 端到端完成
- 拆分条件（满足任一才拆）：
  ① 任务天然有独立的并行工作流（前端 + 后端、多语言、多独立模块）
  ② 任务需要对抗性多视角（辩论/审查）
  ③ 单 worker 无法持有所有必要工具（读写分离场景）
  ④ 任务规模超出单 worker 上下文窗口
- 不拆的条件（满足任一就不拆）：
  ① 任务在一个代码库/模块/文件内
  ② 调研和实现需要共享上下文
  ③ 拆后各 worker 之间需要频繁交换中间产物
```

**2. 引擎层：拆分后观测**

在 `batch_metrics` 中增加**协调效率指标**，让拆分决策有数据回馈：

| 指标 | 公式 | 健康阈值 |
|---|---|---|
| 有效并行度 | `avg_parallelism / worker_count` | ≥ 0.5 (低于说明串行居多，不该拆) |
| 协调税率 | `(总 token - Σ worker 产出 token) / 总 token` | ≤ 0.3 (超过说明协调开销过大) |
| 便签墙活跃度 | `notes_posted / worker_count` | 0 = 可能不需要协作；> 3 = 协作真实发生 |

这些指标不改运行时行为，但为后续的「自动拆分建议」提供数据基础。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `runtime/resolve/prompt.py` | 路由判据补充「默认不拆」原则 |
| `runtime/skills.py` | `team_orchestration_advanced` 增加拆分成本意识 |
| `runtime/runs/wave.py` | `BatchMetrics` 补充协调效率指标 |
| `tools/builtin/delegate/drive.py` | 结构化日志补充协调税率 |

---

## 优化三：Worker 内部自决拆分 — CEO 管大方向，Worker 管怎么做

> **通俗说**：CEO 只定「谁负责哪块」，具体怎么拆、要不要再叫人，交给真正干活的 Worker 自己决定。

### 现状问题

当前 `can_delegate` 是 CEO 在派活时设置的静态开关（`true` / `false` 两档）。核心摩擦：
1. CEO 派活时对任务细节了解最少——还没开始做，怎么知道需不需要拆？
2. Worker 执行中发现可并行，但没被授权时只能串行完成
3. CEO 替 Worker 规划内部结构，违背「干活的人最了解手上的活」原则

### Cursor 的做法

协调者只做高层路由，不做细粒度拆分：
> "This task appears parallelizable internally. You may break the work into internal subagents as appropriate."

Worker 自行决定是否拆分、如何拆分。

### 设计原则：CEO 管"做什么"，Worker 管"怎么做"

CEO 的规划应聚焦于**大方向**（"你负责前端""你负责调研竞品"），而非替 Worker 规划内部步骤。拆分决策下放给真正干活的人——与优化二自洽：**CEO 层面少拆（一个 coherent worker），Worker 层面按需自拆**。

### 目标设计：简化为两档 `can_delegate`

去掉 `true`（"CEO 替你决定你需要带队"本身违背自治原则），简化为：

| 值 | 意思 | 什么时候用 |
|---|---|---|
| `false` | 这是个小活，不需要拆 | 写一个文件、做一次查询等简单叶子任务 |
| `"auto"`（非简单任务的默认） | 你自己看着办，需要拆就申请 | 大多数有实质工作量的任务 |

**默认值规则**：引擎在 `builder` 层自动设定——非简单任务默认 `"auto"`，简单叶子任务默认 `false`；CEO 也可显式覆盖。

**为什么去掉 `true`**：
- `true` 意味着"CEO 提前替 Worker 决定需要带队"——但 CEO 在派活时信息不完整，这个判断经常不准
- CEO 确信要拆的场景，CEO 应该在自己的 `delegate` 层面直接拆好，而不是把"规划子团队"甩给 Worker
- `auto` 已覆盖不确定地带；确定不需要拆的用 `false`

**`auto` 模式的行为**：

1. Worker 启动时不注入 `delegate` / `replan`（避免工具噪音）
2. Worker 的 system prompt 注入指引："如果你发现任务可以并行拆分，且拆分收益明显大于串行，调用 `request_delegate` 申请派人权"
3. `request_delegate` 是一个轻量工具，Worker 调用时提交拆分理由 + 预期 tasks 数量
4. 引擎做机械检查（当前深度 < MAX、任务刚开始不是快完了、预期 tasks 数 ≤ 上限）后注入 `delegate` 工具
5. 不需要拆分的 Worker 永远不会触发这个路径，零额外开销

**为什么不直接给所有 worker `delegate`**（与 `auto` 默认的区别）：
- `auto` 是非简单任务的**默认**：Worker 有权按需申请，但启动时不注入 `delegate` 工具
- 被否决的是**启动时直接注入** `delegate`：绝大多数简单叶子任务（80%+）永远用不到，多一个工具 = 提示词噪音
- 不必要的 `delegate` 工具被模型当作可用选项，增加「为拆分而拆分」的风险

**迁移路径**：现有 `can_delegate=true` 的场景逐步迁移到 `auto`；过渡期 `true` 等价于 `auto`（Worker 启动时直接注入 delegate，行为不变）。待验证 `auto` 效果后，废弃 `true`。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `runtime/runs/types.py` | `RunSpec.can_delegate` 类型改为 `Literal[False] | Literal["auto"]`（废弃 `true`） |
| `runtime/runs/builder.py` | `_build_spec` 处理两档值；非简单任务默认 `"auto"`，简单叶子任务默认 `false` |
| `runtime/runs/executor_agent.py` | `auto` 时不初始注入 delegate，监听 `request_delegate` |
| `tools/builtin/request_delegate.py` | 新增轻量工具（仅 `auto` 模式可用） |
| `tools/builtin/delegate/nesting.py` | `make_lead_subteam` 支持延迟创建 |

---

## 优化四：通知驱动协调 — CEO 更早释放控制

> **通俗说**：CEO 派完人就该放手等通知，别一直占着位子干等——就像项目经理派活后去处理别的事，完成后再回来验收。

### 现状问题

当前 CEO 调用 `delegate` 后，委派驱动逻辑在 CEO 的思考循环内阻塞等待波次调度完成（或暂停等续跑）。这意味着：
- CEO 的 LLM 上下文在整个执行期间保持，增加成本
- 简单任务（单 worker，finalize=true）的 CEO 上下文也被占用直到完成
- CEO 无法在等待期间做任何事（如响应新的用户消息）

### Cursor 的做法

协调者委派后立即结束当前轮次：
> "After delegating the only coherent worker task, do not continue doing the same investigation. Just end your response and you will be notified when the subagent completes."

### 目标设计：`finalize` 路径的早释放

这个优化的范围有限——AgentCore 的 CEO 是会话级 Agent（要持续跟用户对话，不是 Cursor 那种纯协调层），且 `delegate` 是思考循环内的工具调用。但可以在**特定路径**上减少 CEO 的阻塞等待：

**Phase 1：`finalize=true` 单 worker 的早释放**

当前 `finalize=true` 已省掉 CEO 合成轮，但 CEO 仍在 `_drive` 内等待 worker 完成。优化：

```
finalize=true + 单 worker 时：
  1. CEO 调 delegate(finalize=true, tasks=[单任务])
  2. _drive 提交 worker 到 WaveScheduler 后立即返回 HANDOFF
  3. CEO ReAct 循环终止（FinishReason.HANDOFF）
  4. Worker 完成后，产出直接作为回合答复（已有机制）
  5. 若 Worker 失败，回落创建 CEO 续轮处理
```

收益：finalize 路径下 CEO 的 LLM 调用减少一轮（等待轮），延迟降低。

**Phase 2：多 worker 的分段释放（远期）**

CEO 在波边界只有「定稿/纠偏」的决策需求。无边界事件时，CEO 可以在更早的时间点释放：

```
无晚绑定 + 无 checkpoint + 无 scope escalation 时：
  - CEO 可在所有节点 RUNNING 后释放
  - Worker 完成 → 回调唤醒 CEO 收尾
```

这需要「CEO 状态落盘 + 续跑」能力，与现有 `paused_turns` 机制可复用，但复杂度较高，列为远期项。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `tools/builtin/delegate/drive.py` | finalize 单 worker 路径提前返回 HANDOFF |
| `tools/builtin/delegate/tool.py` | 调整 finalize 路径的 ToolEffect |
| `runtime/runs/executor_captain.py` | 处理 finalize 早释放的 captain 侧逻辑 |

---

## 优化五：三档自主度结构化 — 从 prompt 到运行时策略

> **通俗说**：Worker 遇到问题时该自己修、先试一轮、还是立刻上报——现在全靠提示词猜，需要变成可配置的三档规矩。

### 现状问题

Worker 的自主度当前由 prompt 和 `escalate`（向上汇报）工具共同表达，但：
- "什么时候该 escalate、什么时候自己解决"完全靠 prompt 引导
- 模型经常在该 escalate 时硬猜（`dep` kind 的场景），或在不该 escalate 时频繁上报（`normal` kind）
- Cursor 项目规则的三档分类（`.cursor/rules/multitask.mdc`）已证明清晰分档对模型行为有显著引导作用

### Cursor 的做法

结构化三档：

| 情况 | 行为 |
|---|---|
| 琐碎障碍（路径拼写、import 缺失、lint 报错） | 自行修复，不用回报 |
| 执行层问题（测试挂了、需要多改一个文件） | 尝试修一轮；修不好就停下回报 |
| 方案层问题（方案不可行、需改接口契约） | 立即停下回报，不自行决策 |

### 目标设计：`RunPolicy.autonomy` 字段

在 `RunPolicy` 中增加 `autonomy`（自主度）配置，让 CEO 在 delegate 时为每个 worker 设定「遇到问题自己扛多少」：

```python
class AutonomyPolicy(str, Enum):
    FULL = "full"         # 全自主：琐碎和执行层问题都自己修，只有方向性分歧才上报
    STANDARD = "standard" # 默认档：琐碎自修、执行层试一轮、方向性问题上报
    GUIDED = "guided"     # 严格受控：几乎每个决策点都上报（高风险任务）
```

**运行时行为**：

| 档位 | 琐碎障碍 | 执行层问题 | 方案层问题 |
|---|---|---|---|
| `full` | 自修 | 自修（重试 ≤2 次） | `escalate(kind=scope)` |
| `standard` | 自修 | 尝试一轮；失败 → `escalate(kind=normal)` | `escalate(kind=scope)` |
| `guided` | `escalate` 记录 | `escalate` 等指示 | `escalate(blocking=true)` |

**实现方式**：`autonomy` 不改变 `escalate` 工具的 schema，而是影响 **worker system prompt 中的自主度指引段落**——根据 `autonomy` 值，`resolve/prompt.py` 在 worker 的系统提示中注入不同的自主度策略。这保持了 prompt 驱动行为的灵活性，同时让 CEO 能为不同任务选择适当的控制力度。

**CEO 侧决策**：`autonomy` 默认 `standard`，CEO 在以下场景主动调整：
- 高风险/不可逆操作 → `guided`
- 简单机械任务 → `full`
- Worker 历史表现（远期：基于 MAST 评测数据的自动调整）

### 涉及文件

| 文件 | 改动 |
|---|---|
| `runtime/runs/types.py` | `RunPolicy` 加 `autonomy: AutonomyPolicy` |
| `runtime/resolve/prompt.py` | worker prompt 按 autonomy 注入不同策略段 |
| `tools/builtin/delegate/tool.py` | schema 加 `autonomy` 可选字段 |
| `runtime/runs/builder.py` | `build_run_plan` 传递 autonomy |
| `runtime/skills.py` | 更新 `team_orchestration_advanced` 说明 |

---

## 优化六：前台/后台职责硬隔离 — 防止 CEO 重复已委派工作

> **通俗说**：CEO 已经派了人去调研，自己就别再打开同一批文件重查一遍——协调者做协调的事，执行者做执行的事。

### 现状问题

CEO 偶尔出现"委派了又自己干"的情况：
- 委派了一个调研 worker 后，CEO 自己也开始 `file_read` 做同样的调研
- 委派了写代码的 worker 后，CEO 在收尾时过度重读产物（超出综述所需）
- 根因：CEO prompt 说"开工前轻量探路、收尾综述"，但"轻量"的边界模糊

### Cursor 的做法

硬性规则：
> "Before each foreground tool call, distinguish coordination work from the worker task you already delegated. If the next tool call would do the delegated work, stop."

### 目标设计：委派后工具降级

**在 `delegate` 返回控制后的 CEO 续轮中，限制 CEO 的只读工具使用**：

```
delegate 完成 → CEO 收尾续轮时：
  工具可用性：
    - ask_user: ✅ (可向用户汇报/发问)
    - delegate: ✅ (可追加委派)
    - replan: ✅ (可续跑)
    - revise: ✅ (可热修)
    - file_read: ⚠️ 受限（只允许读 worker 产出的文件，不允许读其他文件）
    - grep/file_list: ❌ 禁用（调查工作应由 worker 完成）
    - web_search/read_url: ❌ 禁用（同上）
```

**实现方式**：在 `delegate` 工具返回后，设置一个 `post_delegate` 上下文标记。`LoopController` 在后续轮次的工具调用前检查此标记——如果 CEO 调用了非协调类工具，注入一条系统消息："你已将此工作委派给团队。请使用团队产出写综述，不要重复调查。"

**为什么不硬禁工具**：
- CEO 的收尾确实需要偶尔读 worker 产出的文件（验证对账）
- 硬禁可能导致 CEO 无法完成合法的收尾工作
- 选择「软提醒 + 次数上限」：第一次提醒、第二次提醒、第三次强制 FINALIZE

**与已移除的 `delegation_nudge` 的区别**：
- `delegation_nudge` 是在 CEO **未委派时**提醒它应该委派（模型可以合理忽略）
- 本方案是在 CEO **已委派后**阻止它重复做（更明确的逻辑错误，模型更易遵从）
- 触发条件更精准：只在 delegate 返回后的续轮中生效

### 涉及文件

| 文件 | 改动 |
|---|---|
| `runtime/engine/loop.py` | `post_delegate` 上下文标记 + 工具调用前检查 |
| `tools/builtin/delegate/tool.py` | delegate 返回时设置标记 |
| `runtime/resolve/prompt.py` | 收尾续轮的系统提示强化 |

---

## 实施路线

### Phase 1：低风险、高收益（纯 prompt + schema 微调）

| 优化项 | 具体内容 | 预期收益 | 风险 |
|---|---|---|---|
| 优化一·Prompt 层 | CEO 路由判据升级为决策树 + 示例 | 减少不必要的 delegate | 低（纯提示词，可回退） |
| 优化二·Prompt 层 | 增加拆分成本意识 + 默认不拆原则 | 减少过度拆分 | 低 |
| 优化五·Prompt 层 | worker 自主度三档指引段 | worker 行为更可预期 | 低 |

### Phase 2：引擎层增量改动

| 优化项 | 具体内容 | 预期收益 | 风险 |
|---|---|---|---|
| 优化一·Schema 层 | `complexity_hint` 字段 + 轻委派裁剪 | finalize 路径开销降 30%+ | 中（新字段，需测试） |
| 优化四·Phase 1 | finalize 单 worker 早释放 | CEO 等待时间降低 | 中（执行路径改动） |
| 优化六 | 委派后工具降级 | 减少 CEO 重复调查 | 中（需验证不误伤合法收尾） |

### Phase 3：结构性改动

| 优化项 | 具体内容 | 预期收益 | 风险 |
|---|---|---|---|
| 优化二·引擎层 | 协调效率指标 + 数据驱动拆分建议 | 长期拆分决策质量提升 | 低（观测不改行为） |
| 优化三 | `can_delegate` 两档（`false` + `auto`，废弃 `true`）+ `request_delegate` | Worker 按需申请拆分权，CEO 不再预判 | 高（新执行路径） |
| 优化五·运行时层 | `AutonomyPolicy` + prompt 注入 | 精细化控制 | 中 |

### Phase 4：远期

| 优化项 | 具体内容 | 依赖 |
|---|---|---|
| 优化四·Phase 2 | 多 worker 分段释放 | CEO 状态落盘 + 续跑 |
| 协调效率自动反馈 | 据指标自动建议拆分策略 | Phase 3 指标积累 |

---

## 不做 / 被否决

| 方案 | 理由 |
|---|---|
| 替换 CEO 为纯路由器 | CEO 的精细规划能力是 AgentCore 核心壁垒（复杂任务的 DAG 编排 >> Cursor 的单 worker 路由） |
| 前置分类器 LLM | 已否决（每条消息付编排税，见编排器 §聊天优先） |
| Worker 直接通信 | 已否决（成本、不可观测，见协作模式 §二） |
| 取消 CEO 收尾综述 | CEO 的「一个声音」是产品核心体验 |
| `can_delegate=true`（CEO 预判 Worker 需要带队） | CEO 派活时信息不完整，判断常不准；确信要拆的场景应在 CEO 自己的 `delegate` 层面直接拆好，而非把规划子团队甩给 Worker |
| 启动时给所有 worker 直接注入 `delegate` 工具 | 与 `auto` 按需申请相反：简单叶子任务不需要；非简单任务已有 `auto` 默认，Worker 需要时再申请即可，启动即注入徒增提示词噪音和「为拆分而拆分」风险 |

---

## 度量与验收

优化效果需要数据验证。以下为各优化的关键度量：

| 优化 | 关键度量 | 验收标准 |
|---|---|---|
| 智能委派决策 | CEO 直答 vs 委派的比例变化；单 worker finalize 的比例 | 简单任务直答率 ↑；单 worker finalize 占比 ↑ |
| Coherent Worker 优先 | 平均 worker 数 / 回合；有效并行度 | 平均 worker 数 ↓（过度拆分场景）；有效并行度不降 |
| Worker 自决拆分 | `request_delegate` 激活率；激活后实际并行度 | 激活率 10–30%（太高说明应在 CEO 委派时直接拆好，而非指望 Worker 事后拆） |
| 通知驱动 | finalize 路径 CEO 等待时间 | 等待时间趋近 0 |
| 三档自主度 | escalation 数量 / 回合；escalation 有效率 | 无效 escalation ↓；有效 escalation 保持 |
| 职责隔离 | CEO 收尾轮只读工具调用数 | 收尾轮工具调用数 ↓ |

度量在内测阶段以 `batch_metrics` 扩展 + `log_stats` 结构化日志为主，不建独立度量子系统。
