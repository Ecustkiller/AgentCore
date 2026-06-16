# 编排器与 CEO 主 Agent

> **状态**：已确定并落地（CEO 主 Agent + `delegate` 原语 + 协调者工具边界：CEO 仅持只读/检索工具、生产变更全委派）；CEO/worker 的 system prompt 已确立「身份 + 边界」结构，细节（CEO 升级判据 / worker 角色模板）待迭代
>
> → 见代码：`apps/server/agentcore/tools/builtin/delegate.py`

---

## 核心定位：CEO 主 Agent 模型

编排能力归属于一个**会话型「CEO」主 Agent**——它既是**唯一对话入口与声音**，也是**团队规划大脑**。CEO 直接与用户对话、可来回澄清；当任务确需团队时，它通过 `delegate` 工具**下达子任务**，驱动执行引擎调度多个 worker 并行/串行工作，并**用自己的声音收尾汇报**（合成器角色并入 CEO）。

CEO 是**协调者**：它只直接持有「只读 / 检索」工具（联网搜索、读网页、读文件、列目录、grep），用来理解意图与直接作答；一切会**产出或改动产物**的工作（写 / 改 / 删 / 移文件、运行代码）它都不持有相应工具，必须经 `delegate` 交给 worker——即便只派一个。worker 持有全套工具去动手。

> 这是「聊天优先 + 按需编排」的统一收敛：把原先的「聊天 Agent + 隐形编排器 + 合成器」三套人格合并为**一个 CEO**，消除职责重叠与人格切换，并让编排获得「先澄清再下达」的能力。
>
> **底线**：合并的是「对用户的身份/声音」，不是「每轮都跑重规划」。CEO 默认走快的会话档，只读/检索类对话直接作答（零编排开销）；「组团/下计划/动手产出」是按需触发的能力。

### 职责边界（CEO）

```
✅ 与用户直接对话、必要时来回澄清（D2）
✅ 只读 / 检索类请求直接作答（搜索、读网页、读文件、列目录、grep；承袭聊天优先，零编排开销）
✅ 理解意图、分解任务、决定 worker 数量与角色、分配工具集
✅ 用 delegate 的 depends_on 定义步骤依赖（驱动并行/串行）
✅ 团队跑完用自己的声音收尾汇报（D3，只写简短概览）
❌ 不直接持有生产 / 变更工具（写 / 改 / 删 / 移文件、运行代码）——这类活一律 delegate 给 worker，CEO 不亲自下场堆产出
❌ 重规划只在按需触发时支付，绝不让简单对话背上规划税
```

### 协调者工具边界（档2）✅ 已确定

CEO 的工具面**只保留只读 / 检索**（`web_search`、`read_url`、`file_read`、`file_list`、`grep`），**生产 / 变更**（`file_write`、`str_replace`、`file_delete`、`file_move`、`code_execute`）从 CEO 手里拿掉、只交给 worker。

| 切法 | 决策 |
|------|------|
| 分界依据 | 按工具 `approval` 级别：`NEVER`（自动执行、不改环境）= CEO 直接持有；`GRANTABLE`（改动环境、需授权）= 仅 worker 持有。语义自洽，且新增只读工具自动归 CEO、新增变更工具自动留 worker（单一事实源 `build_builtin_registry`） |
| CEO 直接做 | 纯问答 / 闲聊 / 解释，以及只靠检索就能回答的请求——零团队开销，首字即时 |
| 一律委派 | 任何产出或改动产物的工作，哪怕只写一个文件、改一行，也派一个 worker（CEO 没有这些工具） |

**为什么是档2（被否决：档1「全能 CEO」、档3「纯编排 CEO」）：**

- **档1（CEO 持全套工具，仅复杂任务才委派）**——CEO 上下文易被大块工具输出污染，长会话越来越贵，「团队协作」心智被弱化。
- **档3（CEO 只剩 `delegate`，连检索都过 worker）**——已评估否决：把高频检索也压上 worker 往返，延迟与成本显著上升，且「检索大输出不进 CEO 上下文」已被历史重建原则（工具 I/O 不跨轮回放）基本覆盖。
- **档2 取中**：拿走瘦身最大的两份收益（团队心智 + CEO 上下文洁净），又把「委派税」约束在「只有真正产出 / 变更时才付」，不碰高频只读路径。

> **轻量直出（finalize）✅ 已落地**：单 worker 仍跑完整 worker 循环，但当 CEO 判断"本次只派一个 worker、且这次委派即整件事的最终交付"（建个文件 / 改一行）时，可在 `delegate` 设 `finalize=true`——该 worker 成功后其产出**直接作为回合答复**（`ToolEffect.HANDOFF` 终态），省掉 CEO 再写一段概览的合成轮；多 worker 或 worker 失败时自动回落到 CEO 收尾（安全兜底）。worker 用量仍记在工具实例上由 pipeline 折算，终态返回不带 token 以免双计。
>
> **仍待评估**：是否再给 CEO 一条"快速编辑"后门（本地模式对标 Cursor 即时小改），需与"协调者只读边界"权衡——这是另一回事（给 CEO 自己装写工具，已否决的档1方向），留待后续单独决策。

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
| 简单对话 / 问答 / 单点检索 | CEO 直接流式回答（零编排开销） | 首字即时，体验同 ChatGPT |
| 需要产出 / 变更，或需要团队的复杂任务 | CEO 调 `delegate` → worker（单个或多 Agent DAG）→ CEO 收尾汇报 | 协作面板展开，展示分工；全程一个声音 |

升级由模型自决：CEO 每轮都在，自己判断要不要组团；误判时优雅降级——不调 `delegate` 即等价单 Agent 直答，不空转组团。

> **被否决：编排器是唯一入口（无前置分类器，每轮必经编排器 LLM）。** 原方案让每条消息（哪怕「你好」）都先付一次完整编排器往返，实测对简单输入也有 ~15s 首字延迟，95% 对话的编排纯属高频聊天的「税」。改为「聊天优先 + 按需编排」后，编排开销只在真正需要团队时支付，对齐 Claude Code（Task 工具）、OpenAI Agents SDK（agents-as-tools）的行业范式。原方案「避免两套决策逻辑不一致」的诉求，改由 CEO 统一承担「每轮判断是否升级」来满足。

---

## 一、`delegate` 原语（D1′ / D2 / D3）

CEO 在自己的 ReAct 循环里调用单一的 `delegate` 工具把一批子任务交给内联 worker——**图由 CEO 在循环里增量声明**，非外部一次性 JSON 计划。

### 自选粒度（D1′）

`delegate(tasks=[…])` 的 `tasks` 由 CEO 自定批量：

- **一次塞 N 个** = 全景计划（一批声明完整分工）
- **后续再调一次** = 动态委派（按进展追加）

同一工具 / 同一 schema / 同一调度，CEO 自选委派粒度。并行度由**节点的 `depends_on` 数据声明**（无依赖即同波并行），而非靠模型主动发并行 tool call。

### 终态语义：非终态，CEO 收尾（D3 + 决策①）

`delegate` **默认是非终态工具**：worker 跑完后，结果交回 CEO 的 ReAct 循环，CEO **用自己的声音**写最终答案（`content_delta`）。**例外（finalize，提案2a ✅）**：当 CEO 对一个单 worker 的最终交付设 `finalize=true` 且该 worker 成功时，`delegate` 转为**终态**（`ToolEffect.HANDOFF`）——把 worker 产出直接推到气泡作为回合答复，不再触发 CEO 合成轮；多 worker / 失败时仍按非终态由 CEO 收尾。见上文 §协调者工具边界「轻量直出」。

> **决策①**：CEO 只写**一段简短概览**（综述关键结论、串起整体、指引用户看细节），**不复述各 worker 全文**——每个 worker 的完整产出由前端单独展示（run 详情 / 图视图）。这消解了「CEO 重读全文合稿」的开销。
>
> **被否决：SYNTHESIS 合稿节点**（在 plan 末尾挂一个独立合稿 Agent）。合稿仍是「循环外一趟」，正是 CEO 模型想溶解的形态；`react_loop` 现成支持「工具返回后继续循环」，无需独立节点。

### execute 流程（概念）

`delegate(tasks)` → `build_run_plan` → `run_plan` SSE 预声明 → `WaveScheduler.run` → worker 产出折叠回 CEO（非终态）或 `finalize` 直出。机制详述见 [`执行引擎架构设计.md`](/docs/03-AI核心/执行引擎架构设计.md) §一、§十四。

---

## 二、关键字段设计决策

`delegate` 每个 task 的字段语义见文首代码指针。下表只记录设计理由。

### 2.1 `model_preference` — 模型偏好

CEO 不指定具体模型，只表达能力需求，由运行时映射（fast/strong 两档抽象 → DeepSeek V4）：

| 值 | 含义 | 运行时映射（基座 = 经济模型） |
|---|---|---|
| `fast` | 速度/成本优先，简单机械子任务 | DeepSeek V4 Flash（思考 high，小轮数预算） |
| `strong` | 质量优先，复杂子任务 | 基座 Flash；高质量档 / 自定义档可提升至 Pro |

> 现状：两 worker 档基座均为 Flash（思考 high，靠轮数预算区分，开发期降本）；把 `strong` 提到 Pro 由**质量档**（下文）按用户 / 对话 / 运营默认开启，已取代原 `_STRONG_MODEL` 全局单点翻转（路线图 P1-7）。运行参数单一真相源 `llm/config.py`（`PROFILES`、`agent_profile`、`apply_overrides`）。

设计理由：① 解耦委派与具体模型，模型更新不改委派逻辑；② 用户可覆盖映射（即下文质量档）；③ 未来可做智能路由。

**质量档（用户可选模型层，决策② 的落地）** ✅：在 `delegate` 的 fast/strong 抽象之上，用户以**团队语言**为团队选模型——一个「质量档」= 团队角色 → 模型映射，叠加在 `PROFILES` 基座上，**只换 model、不动思考 / 温度 / 轮数**（调参是工程关注点，非用户旋钮）。

- **角色**：CEO 本体（`chat`）/ 主力 worker（`agent.strong`）可配；**经济 worker（`agent.fast`）锁定 Flash**（决策：经济档「按定义就便宜」，升 Pro 自相矛盾）。
- **预设（只读）**：`经济档` = 全程 Flash = 系统默认；`高质量档` = CEO 本体 + 主力 worker 升 Pro。用户可在运营 ceiling 内建自定义档。
- **两层合成**：运营 `selectable_models` 设可选模型上限（写入校验 + 解析时 `_clamp_to_ceiling` **双重**钳制，旧档在 ceiling 收紧后仍安全）；用户档在其内取值。
- **解析优先级**：对话 → 用户默认 → 运营默认 → 系统默认（经济）；未知 / 已删档回落经济——模型配置问题**绝不打断回合**（同 `pricing_for` / `get_profile` 的 fail-safe）。
- **纯函数 + 注入**：`resolve_profile_set` 每回合解析出 `ProfileSet` 显式注入流水线（无模块级可变全局），并发回合互不串档。前端设置页 UX 见 [`../04-前端/前端UX设计.md` §十三](/docs/04-前端/前端UX设计.md)。

### 2.2 `depends_on` — 依赖关系（并行/串行的唯一开关）

执行形状是**数据不是模式**：

- `depends_on: []` → 可立即启动（与其他无依赖步骤并行）
- `depends_on: ["a"]` → 等 a 完成后启动
- `depends_on: ["a","b"]` → 等两个都完成

调度器解析依赖自动确定并行度，无需 CEO 显式声明「这是并行的」。

### 2.3 `result_handling` — 上游产物保真度

下游节点注入上游 `RunState.content` 时的裁剪策略：

| 值 | 含义 | 何时使用 |
|---|---|---|
| `pass_through` | 全文（带硬上限） | 分析/检索→写作链路，须保留金额、法条编号等细节（默认取向） |
| `summarize` | 摘要 | 大扇入合成省 token 的场景 |

> **默认偏全文**：「一律摘要」会丢失关键信息。执行形状由 `depends_on` 自然落定，无需离散计划类型。

### 2.4 `can_delegate` — 嵌套委派开关（一层）✅ 已落地

worker 默认是**叶子**：拿不到 `delegate`、不能再向下拆。当某子任务复杂到需要它自己带一支小队时，CEO 给该 task 标 `can_delegate=true`，该 worker 才获得一个绑定到**自身为 captain** 的 `delegate`，可再委派一层子团队，看到子成员产出后自行整合。

- **硬深度上限 `depth ≤ 2`**（`MAX_DELEGATION_DEPTH`）：CEO（深度 0）→ worker（深度 1）→ sub-worker（深度 2）。深度 2 的 sub-worker **永不获** `delegate`，即使被标 `can_delegate`——执行器在「发不发工具」这唯一一处卡死，树不可能再深（CEO → worker → sub-worker 封顶）。
- **默认关、显式开**：杜绝「为委派而委派」的失控嵌套，只有 CEO 判断确需二次拆分才开。
- **账目按树回滚**：嵌套子队的 token 用量与每-run 成本行（`parent_run_id` 指向其上层 worker）逐层上卷到 CEO 顶层 `delegate`，整棵树的花销最终汇入回合总账，不双算、不漏算。
- **并发不爆**：树级并发预算（`MAX_PARALLEL_DELEGATIONS`，ContextVar「分而不乘」）在嵌套 fan-out 下仍封顶，深度 × 扇出不相乘。

> 设计理由：真正的「Agent 团队」需要队长能再带队，但无界递归会让成本 / 延迟 / 并发指数爆炸。一层上限是「表达力 vs 可控」的平衡点——既覆盖「复杂子任务自带小队」，又把爆炸面钉死在单层。被否决：不设上限的自由递归（成本不可预期）、worker 一律可委派（绝大多数子任务并不需要，徒增开销）。

---

## 三、失败处理

| 失败场景 | 处理策略 |
|---------|---------|
| `delegate` 参数非法（无环校验失败、工具未注册、档位非法等） | `build_run_plan` 收集 `errors` 非终态返回 CEO，CEO 改参数重试 |
| 单个 worker 失败 | 按节点 `on_failure`（`skip` / `abort` / `retry`）处理，单 worker 失败不必拖垮整 DAG |
| CEO 判断无需团队 | 不调 `delegate`，直接作答（等价单 Agent，安全兜底） |

---

## 四、检查点与团队预审

**产品触发**：CEO 在关键岔路调 `ask_user`（运行时自决）；DAG 计划在 step 标 `checkpoint_after` 时由调度器波间挂起 `plan_review`。**边界**：`ask_user` = CEO 工具效应；`checkpoint_after` = 计划期声明的结构挂起——语义、2b 续跑、事件契约见 [`执行引擎架构设计.md` §检查点决策语义 / §暂停与恢复](/docs/03-AI核心/执行引擎架构设计.md)。

**团队预审 preflight（⏳ Phase 2）**：执行前团队预览 gate 仍待 preflight 审计回归，与结构化波间挂起是不同议题。

---

## 五、待定事项（Phase 2 及以后）

| 议题 | 说明 |
|------|------|
| CEO / worker system prompt 内容调试 | 「身份 + 边界」结构已落地（CEO `CHAT_TEAM_CAPABILITY_HINT`、worker 自我认知段）；剩余为内容调试：CEO 升级判据、worker 角色模板 |
| Agent 实体化 | Phase 1 worker 为内联角色（`agent_id == run_id`）；Phase 2 收敛到 `agent_id` + `AgentResolver` + 委派白名单 |
| 增量声明优化 | 批次预声明（`run_plan` 带 `parent_run_id`，供图在 run 开跑前成组）+ `run_started` 带 `parent_run_id`/`kind` + **嵌套委派一层均已落地**（见 §2.4）；剩余为更细粒度的增量重声明 / 跨波动态重排（未定） |
| 交互原语回归 | `ask_user` 挂起 ✅ 已落地（见 §四）；`plan_review` / `checkpoint_after` 波间挂起 ✅ 2a + 持久续跑 2b ✅ 已落地（见 §四）；剩余 preflight / 契约闸门 / 治理强制层（远期）⏳ |
| 多轮编排 | **✅ 已落地**：后续消息沿用 / 修改之前的委派结果——CEO 经 `revise` 唤回原队员带现场记忆续写（内存 + 跨进程落盘留人，双 miss 回落重派），图上挂「修订 vN」版本链。详见 [`多轮编排与队员热修.md`](/docs/03-AI核心/多轮编排与队员热修.md) |
