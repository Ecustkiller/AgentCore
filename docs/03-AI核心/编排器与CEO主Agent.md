---
status: landed
code: apps/server/agentcore/tools/builtin/delegate/
related:
  - docs/03-AI核心/运行时总览.md
  - docs/03-AI核心/执行引擎架构设计.md
skip_if:
  - 只改 WaveScheduler 内核（读执行引擎）
---

# 编排器与 CEO 主 Agent

> **状态**：已确定并落地（CEO 主 Agent + `delegate` 原语 + 协调者工具边界 档2.5：CEO 仅持只读/检索工具，且这些工具只供**侦察/收尾**——生产变更与**成规模的广度调查**都委派）；CEO/worker 的 system prompt 已确立「身份 + 边界」结构，路由先判**信息够不够**（产出类请求没说全先 `ask_user` 开工提案卡）、再按**两档路由**判自己做/交团队（直答 / 委派；委派内再按单 worker vs 多 worker DAG 规划），细节（worker 角色模板 / 各 Skill 正文打磨）待迭代
>
> → 见代码：`apps/server/agentcore/tools/builtin/delegate/`（已由单文件拆为包）、`tools/builtin/replan.py`

---

## 核心定位：CEO 主 Agent 模型

编排能力归属于一个**会话型「CEO」主 Agent**——它既是**唯一对话入口与声音**，也是**团队规划大脑**。**身份层级**：用户是老板，CEO 受其雇用、替其掌管这支团队并对其负责，用户才是最终决策者——CEO 关键岔路向用户请示、收尾向用户汇报。CEO 直接与用户对话、可来回澄清；当任务确需团队时，它通过 `delegate` 工具**下达子任务**，驱动执行引擎调度多个 worker 并行/串行工作，并**用自己的声音收尾汇报**（合成器角色并入 CEO）。

CEO 是**管理者**（不是调查员）：它只直接持有「只读 / 检索」工具（联网搜索、读网页、读文件、列目录、grep、**Git 只读** `status`/`diff`/`log`），但这些工具是给它**侦察（开工前轻量探路、判断怎么拆 / 派谁）与收尾（综述团队成果）**用的，**不是让它独自跑完整场调查**。两类活都交给团队：① 会**产出或改动产物**的工作（写 / 改 / 删 / 移文件、**Git 写入**、运行代码）——它本就不持有相应工具，必须 `delegate` 交给 worker，即便只派一个；② **成规模的广度调查**（要横扫大量文件 / 来源、可拆多角度并行）——哪怕只读、哪怕最终只回用户一段话，也应 `delegate` 扇出并行调研 worker，各自检索后回报**精炼结论**，再由 CEO 综述。worker 持有全套工具去动手。

> **底线**：对用户呈现**一个 CEO 声音**；CEO 默认走快的会话档，**轻量 / 单点**的只读对话直接作答（零编排开销）；「组团/下计划/动手产出/广度调查」按需触发。

### 职责边界（CEO）

```
✅ 与用户直接对话、必要时来回澄清（D2）
✅ 轻量 / 单点的只读请求直接作答（一两处文件 / 一条事实就能答；搜索、读少量已知文件、列目录、grep；承袭聊天优先，零编排开销）
✅ 开工前用只读工具轻量探路（判断怎么拆、派谁），团队跑完用自己的声音收尾综述（D3，只写简短概览）
✅ 理解意图、分解任务、决定 worker 数量与角色、分配工具集
✅ 用 delegate 的 depends_on 定义步骤依赖（驱动并行/串行）
❌ 不直接持有生产 / 变更工具（写 / 改 / 删 / 移文件、Git 写入、运行代码）——这类活一律 delegate 给 worker，CEO 不亲自下场堆产出
❌ 不亲自跑成规模的广度调查（逐个 file_read / grep 把整场调查做完）——这类只读但成规模的活也 delegate 给并行调研 worker，CEO 只做开工前探路 + 收尾综述
❌ 重规划只在按需触发时支付，绝不让简单对话背上规划税
```

### 协调者工具边界（档2.5）✅ 已确定

**结构边界（档2，不变）**：CEO 的工具面**只保留只读 / 检索**（`web_search`、`read_url`、`file_read`、`file_list`、`grep`、`git` 只读子集 `status`/`diff`/`log`），**生产 / 变更**（`file_write`、`str_replace`、`file_delete`、`file_move`、`git` 写入子集、`code_execute`）从 CEO 手里拿掉、只交给 worker。`git` 为单工具 + `subcommand` 分派：`schema.approval=NEVER` 使 CEO 注册表自动收录只读子集；CEO 调写入子命令时 `execute` 返回「请 delegate 委派给 Worker」。**路由判据（2.5 细化）**：把「自己做还是交团队」从「**交付物 vs 对话**」重画为「**活的规模与结构**」——见下。

| 切法 | 决策 |
|------|------|
| 分界依据（结构） | 按工具 `approval` 级别：`NEVER`（自动执行、不改环境）= CEO 直接持有；`GRANTABLE`（改动环境、需授权）= 仅 worker 持有。语义自洽，且新增只读工具自动归 CEO、新增变更工具自动留 worker（单一事实源 `build_builtin_registry`） |
| 【直答】（路由） | 单点确认（一两处文件 / 一条事实就能答）、读已知的少量文件、纯问答 / 闲聊 / 解释、分析推理类的**简短回应**，以及**开工前的轻量探路**——零团队开销，首字即时 |
| 【委派】（路由） | 凡需 worker 动手的活：① 实质交付物（代码 / 应用 / 网页、脚本、配置、**成篇**报告 / 文档；哪怕只写一个文件、改一行；task 里点明落盘、成篇文字写 `.md`）；② **成规模的广度调查**（要横扫大量文件 / 来源、可拆多角度并行、需多视角对比 / 辩论、产生大量中间内容）——**哪怕只读、哪怕最终只回一段话**。单 worker 能胜任则 `finalize=true` 直出；多方向 / 多依赖 / 多专长先 `consult_skill(team_orchestration_advanced)` 再规划 DAG |

> **发问优先判据：先判信息够不够、再判规模 ✅ 已落地**：路由两步先后——① 产出类请求若关键高杠杆决策（受众 / 范围 / 产物形态 / 技术取向）用户没说全，先用 `ask_user` 开**开工提案卡**摊出决策（预填默认、一键可开做）再动手，是这类请求的**默认开场**；② 信息齐了再按下文「活的规模与结构」判自己做 vs 交团队。**为何前置**：原路由只有「自己做 vs 交团队」一根二元轴，「先问还是先干」不在轴上、易被「产出类活→直接 delegate」吞掉；提为第一道闸、靠「预填默认=一键通过」避免退回问题墙。详见 §四。→ 见代码：`runtime/resolve/prompt.py`（`_CEO_CORE_HINT`）、`runtime/skills.py`（`ask_user_kickoff` / `ask_user_midtask`）。

> **委派判据：活的规模与结构，而非「产出是不是文件」也非「有没有工具」✅ 已落地**：轻量 / 单点的只读请求 CEO 直答；一旦是**有规模或多角度**的活——实质交付物，**或成规模的广度只读调查**——就 `delegate` 交团队，哪怕答复只是一段话。关键转变：判据看**活的形态**，不看**答复形态**；一个只读调查（「项目哪些功能没完善」「X 怎么实现」「对比这几个模块」）也是团队的活，CEO 自己逐个读既慢（串行）又把大量正文堆进回合内上下文。**运行期收敛护栏**：CEO「该委派却自己埋头只读」主要靠系统提示词从第 0 轮立框约束——曾在 `loop_controller` 试过「累计 N 次只读即注入软提醒」的代码侧软护栏，**A/B 实测被模型忽略且净负（成本↑、调用未降），已移除**；代码侧只保留对**失控暴走**的硬兜底（`loop_controller.convergence_action`：只读轮数越过高阈值才 `FINALIZE`，默认关）。配套防泄漏铁律：CEO 绝不为省委派把整份代码/文件贴进正文。→ 见代码：`runtime/resolve/prompt.py`、`runtime/skills.py`、`runtime/loop_controller.py`。

> **团队形态判据：默认不拆、双向、广度调查归团队 ✅ 已落地**：上面的委派判据定「要不要委派」；这条定「委派后团队多大、调研谁来跑」。**① 默认不拆**：CEO 采用「单 coherent worker 优先」——默认倾向一个 worker 端到端完成；仅当任务天然有独立并行工作流、需对抗性多视角、单 worker 无法持有必要工具、或规模超出单 worker 上下文时才拆分。每多拆一个 worker 即额外支付协调税（上下文传递 + 便签墙 + CEO 收尾 + 产物中转）。**② 判据双向**：拆几个看【活的自然结构】——过度拆碎与塌缩成一个都是偏差；落单 worker / 自己埋头查前先自检，拿不准先 `consult_skill(team_orchestration_advanced)`。**③ 广度调查归团队（不限交付级，哪怕只回一段话）**：任何要横扫大量文件 / 来源、可拆多角度的只读调查，都把各角度作为**并行调研 worker** 一次 `delegate`，task 里点明「回报**精炼结论 + 证据指引**、不回贴整段正文」，再由 CEO 综述（需写成篇产物时用 `depends_on` 汇入下游写手）。CEO 的只读工具只用于**开工前轻量探路 + 收尾综述**，不替团队跑调查腿脚活。**注意**：`result_handling`（`pass_through`/`summarize`）只管**上游→下游**注入保真度，**不**影响回到 CEO 的内容——后者由 task 措辞决定。→ 见代码：`runtime/resolve/prompt.py`、`runtime/skills.py`、`runtime/engine/`。

> **认知分工判据：约束归 CEO、专业方案归专家 ✅ 已落地**：前两条定「要不要委派」「团队多大」；这条定**委派时 task 里该写什么、不该写什么**。**正确边界**：task 交【需求与约束】（目标、硬指标、关键前提、验收底线），交付物的【专业方案】（章节结构、模块划分、设计布局）默认归专家 worker，除非用户已明确指定结构。`contract`（`required_sections` 等）是**验收契约**而非结构蓝图。→ 见代码：`runtime/resolve/prompt.py`、`runtime/skills.py`、`tools/builtin/delegate/`。

> **worker 侧认知分工**：结构所有权、团队拓扑位置、上游落盘许可——→ 见 [`Agent协作模式.md` §二](/docs/03-AI核心/Agent协作模式.md)。

> **结构跟着证据走：提纲作为可把关的流水线步骤 ✅ 已落地**：对需大量调研的成篇交付，用 `depends_on` + `checkpoint_after` 把「定结构」摆到调研之后——并行调研 worker → 写作 worker 先产出提纲（`checkpoint_after` 让用户改批）→ 据定稿提纲写全文。不新增 schema。→ 见代码：`runtime/skills.py`、`tools/builtin/delegate/`。

> **轻量直出（finalize）✅ 已落地**：单 worker 且 `finalize=true` 时，worker 产出直接作为回合答复（`ToolEffect.HANDOFF`），省掉 CEO 合成轮；多 worker 或失败时回落 CEO 收尾。→ 见代码：`tools/builtin/delegate/`。

> **`complexity_hint` 优化信号 ✅ 已落地**：`delegate` schema 含 `complexity_hint`（`light`/`standard` 两档），CEO 显式声明任务复杂度；引擎据此裁剪规划开销——`light` 时跳过 playbook 匹配、默认 finalize、不注入便签墙与兄弟感知块。**引擎自动推断**：单 worker 且无依赖时，若 CEO 未显式声明，引擎自动设为 `light`；缺省 `standard` 时行为不变。→ 见代码：`tools/builtin/delegate/`、`runtime/resolve/prompt.py`。

> **委派后不重复调查 ✅ 已落地**：CEO 委派后，收尾续轮中不 redo 已委派的工作——系统提示强化「用团队产出写综述，不要重复调查」，而非硬禁只读工具（CEO 收尾仍须偶尔读 worker 产出验证）。→ 见代码：`runtime/resolve/prompt.py`。

> **产出形态：文件落盘 vs 文字直出 ✅ 已落地**：worker 按交付【形态】判定写文件还是写正文；CEO 在 task 里点明落盘要求，`ask_user` 开工卡也说明最终交付是工作区实文件。→ 见代码：`runtime/runs/executor.py`、`runtime/resolve/prompt.py`、`runtime/skills.py`。

> **落盘契约门 `requires_files` ✅ 已落地**：CEO 设 `contract.requires_files=true` 声明文件交付；执行器用 `files_touched` 确定性判定，未达标自动返工一次。→ 见代码：`runtime/runs/contract.py`、`tools/builtin/delegate/`。
>
> **`Deliverable.output_schema` ⏳ 阶段 2 预留**：字段可解析进 `Deliverable`，但 delegate schema **不暴露**、`check_contract` **不校验**——保留位，勿当已生效能力。→ 见代码：`runtime/runs/types.py`、`runtime/runs/contract.py`。

> **CEO 提示词形态：精简核心 + 能力目录 + 按需 consult ✅ 已落地**：常驻只保留路由脊柱 + 能力目录；进阶机制做成系统 Skill，用时 `consult_skill`。**分层不变量**：同一条知识只在唯一所有者出现。→ 见代码：`runtime/resolve/prompt.py`、`runtime/skills.py`、`tools/builtin/`。

**为什么是档2.5（结构取档2；档1「全能 CEO」、档3「纯编排 CEO」被否决）：**

- **档1（CEO 持全套工具，仅复杂任务才委派）**——CEO 上下文易被大块工具输出污染，长会话越来越贵，「团队协作」心智被弱化。
- **档3（CEO 只剩 `delegate`，连检索都过 worker）**——仍否决：把**高频的轻量只读**（单点确认 / 探路）也压上 worker 往返，会给 95% 的轻量路径平白加一层延迟与成本。**但原否决理由里「检索大输出不进 CEO 上下文」一句须修正**：历史重建（工具 I/O 不跨轮回放）只清理**跨轮**残留；**回合内**一场广度调查的几十次只读仍会实打实堆进 CEO 当前窗口、把它撑大。这恰恰说明「广度调查该扇给团队」——但这归**委派判据**解决（即 2.5 的路由细化 + 运行期软护栏），而非靠抽走 CEO 的检索工具（那会误伤高频轻量路径）来解决。
- **档2.5 取中**：保留档2 结构的两份收益（团队心智 + CEO 上下文洁净），同时把路由判据从「交付物 vs 对话」纠正为「直答 vs 委派」——既不让轻量只读背上委派税，也不再放任 CEO 把成规模的广度调查独自串行做完；单 worker vs 多 worker DAG 的复杂度梯度下沉到委派内部，不再作为路由层分类。

### 实现方案：自研编排，不依赖第三方框架 ✅ 已确定

| 设计点 | 决策 |
|--------|------|
| 编排器定位 | CEO 主 Agent 的「按需规划能力」：CEO 既对话又规划；简单请求直接答，复杂任务才下达计划 |
| 调度形态 | DAG 波次调度：`delegate` 的 `depends_on` 定形，`WaveScheduler` 逐波驱动 |
| 输入 | 用户请求 + 可用工具清单 + 会话历史（CEO 在 ReAct 循环内掌握） |
| 输出 | CEO 在 ReAct 循环里调用 `delegate(tasks=[…])` 下达子任务（见下「delegate 原语」） |

**为什么自研（被否决：LangGraph / CrewAI 等框架）：** ① 编排是 AgentCore 的核心壁垒，必须完全掌控；② 第三方框架的抽象与「Agent 团队管理」心智模型不完全匹配；③ 避免框架锁定。

### 聊天优先 + 按需编排 ✅ 已确定

入口即 **CEO 主 Agent**（默认走快的 `chat` 档），它直接拥有并回复对话。只有当 CEO 判断某请求**确实需要一个团队**（多视角并行、设计→实现→测试流水线）时，才调 `delegate` 下达子任务、执行 DAG，并由 CEO 自己收尾汇报（需对抗性多视角思考的辩论 / 对比另走 `debate` 编排工具，见 [`辩论编排设计.md`](/docs/03-AI核心/辩论编排设计.md)）。

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

#### 协调模式（默认开）✅ 已落地

多 worker 且根 CEO（`depth==0`）、非 `finalize` 时，`delegate` **默认**立即返回「团队已启动」，`WaveScheduler` 后台跑；CEO 继续 ReAct，消费团队事件（完成 / 便签 / 升级 / 超时 / 全部完成）并用 `update_synthesis` 渐进合成。传 `coordinate=false` 显式退出到经典阻塞；单 worker、`finalize`、嵌套 lead（`depth>0`）**仍走阻塞语义**。

| 约束 | 决策 |
|---|---|
| 启用门 | ≥2 worker + 根 only + 非 finalize；显式 `coordinate=false` 退出 |
| 合成通道 | 草稿走 `team_synthesis_preview`（`in_progress`）；终稿仍 `content_delta` |
| 挂起 | **`team_preview` 在 coordinate fork 之前**挂起即收口（开做后续跑再臂后台）。协调中 `ask_user` 软挂起即收口；状态入 journal，续跑重建（不保活后台调度器）。`checkpoint_after` 波边界**不** durable `plan_review` 收口——只发 `BOUNDARY_YIELD` 协调事件；经典阻塞（`coordinate=false`）仍挂起即收口 |
| Phase 3 | 超时只通知不自动取消；非阻塞 escalate / 便签冲突进事件队列；SCOPE 边界 PROCEED 由 CEO 仲裁；**阻塞 escalate 改 CEO 仲裁**（`resolve_escalation`；偏好/授权/费用类先 ask_user 再 resolve） |

**不变量 B（CEO 仲裁 ⇔ 协调存活）**：`resolve_escalation` **仅**在协调 session 活跃时可用。单 worker / `finalize` / 嵌套 lead / 显式 `coordinate=false` 走经典阻塞——CEO 卡在 `delegate` await 上、波内无活着的 CEO，阻塞 escalate **直挂用户**（`awaiting=user`），**绝不**改挂 CEO（否则 worker↔CEO 死锁，只能靠超时回落）。测 `resolve_escalation` 必须 ≥2 worker 进协调。否决「单人也 awaiting=ceo」除非先改 drive 让单人亦保 CEO 存活（真·A，未做）。

**决策（为何 CEO 自协调）**：通用协调走 **CEO ReAct + 事件队列**，不引入独立协调 / 合成 Agent（延续上文否决 SYNTHESIS），也不复用辩论 Moderator 的确定性循环——CEO 已持完整用户意图与元权限（`replan` / `cancel` / `ask_user`），独立协调者只会多一层意图损失；Moderator 继续专管辩论。成本纪律见 [执行引擎 §协调模式例外](/docs/03-AI核心/执行引擎架构设计.md)。

→ 见代码：`runtime/coordination/`。

> **文件产出清单（收敛免回工作区核对）✅**：`delegate` 汇总附各 worker「文件产出」行，CEO 据此收尾、不必再 `file_list` 回工作区核对。→ 见代码：`runtime/runs/executor.py`、`tools/builtin/delegate/`。
>
> **同一清单兼作防幻觉凭据（footer 守卫）✅**：清单为空时 CEO 不得报「已创建/已完成」，应 `revise` 唤回或重派。→ 见代码：`tools/builtin/delegate/`。

> **回合级「下一步推荐」(CEO→用户) ✅ 已落地**：回合收尾后另发 2-4 条可点选的快捷追问（下一步建议）挂在助手回复下，点选即回填输入框、可改后发——CEO→用户收尾面的延伸（与 §核心定位「收尾向用户汇报」一脉）。它是 worker→CEO「交接简报·建议下一步」的用户侧对偶。机制（finalize 的 World B 窄任务 + `followups_generated`（含 `message_id`）事件、DERIVED 回写 `Message.followups` 列故重载重现、桌面+手机+画布均有）见 [`执行引擎架构设计.md` §回合级「下一步推荐」](/docs/03-AI核心/执行引擎架构设计.md)。

### 收尾即验收：合·验证两道 ✅ 已落地

CEO 收尾从「写综述」升级为「**先对账拼图边、再核验原始目标、最后写概览**」——纯提示升级（不加人 / 不加新暂停 / 不新子系统），落在 CEO 既有看产物的接缝。两道与既有各闸**显式分层不重叠**：per-piece `contract` 管单块达标、**4b** 管块间拼接、**4a** 管整体达成原始意图、防幻觉铁律管文件真落盘。

- **第一道（4b）· 语义边界对账**：在三处接缝先对「拼不拼得上」——**只查冲突 / 缺口 / 重复，不评每块好不好**：① `format_for_ceo`（合并前；CEO 自判「相互依赖、要拼到一起」才查，独立并行跳过）；② `supervised.py::format_bind_boundary`（定稿下游前对上游，catch-early）；③ `format_scope_boundary`（队员报偏离时主动查兄弟接缝——即「`escalate scope` 等举手」的**主动版**）。对出问题就地 `revise`/`replan`/`ask_user`，别在概览里糊过去。判据同便签墙：块间有没有共享接口 / 相互依赖。
- **第二道（4a）· 成品对照原始目标 + 完工判定**（实证 ROI 最高）：写概览前对照【用户原始请求 + 各 task 的 `expected_output`】逐条核验「实质达成」，给明确**完工判定**——未达成就 `delegate`/`replan`/`revise` 补、别假装收工；已达成就收口、别空转。直接对治 MAST 实测两大失败（不认终止条件 / 过早终止），其「加高层目标验证 +15.6%」是全表 ROI 最高的单点干预。
- **一处覆盖两条收尾路径**：改 `ceo_format.py::format_for_ceo` 即同时盖正常终态综述（`drive.py`）与 `replan(stop)` 收尾（`supervised.py::finalize_stopped`）；【团队便签】（便签墙 `active_notes`）正是 4b 的现成输入（见 [`Agent协作模式.md` §波内共享上下文](/docs/03-AI核心/Agent协作模式.md)）。
- **暂不建（开放项）**：高风险「**独立验证回合**」（换一双眼睛复核）人 2026-06-30 明确**暂不建**——它是唯一「新机制 + 每高风险回合真成本」项（不像 4a/4b 是可退提示词），且 4a 已 inline 覆盖；走「先开度量数据闸门、证明 CEO 自检确实漏了『自己批自己』再建」。→ 远期项见 [`../06-规划/远期规划.md` §2.5](/docs/06-规划/远期规划.md)。

→ 见代码：`tools/builtin/delegate/ceo_format.py`（`format_for_ceo`）、`tools/builtin/delegate/supervised.py`（`format_bind_boundary` / `format_scope_boundary` / `finalize_stopped`）。

### execute 流程（概念）

→ 见 [`执行引擎架构设计.md` §三](/docs/03-AI核心/执行引擎架构设计.md)（`delegate` → `build_run_plan` → `WaveScheduler`）。

### `replan`：波边界续跑（第三编排原语）✅ 已落地

`delegate` / `revise` 之外的第三个编排原语。当计划含**晚绑定节点**（`bind_after_deps`）或队员报告**职责偏离**（`escalate kind=scope`）时，`WaveScheduler` 在决策边界把控制权交回 CEO——`delegate` 输出**非终态**「计划已让出」简报，CEO 调 `replan` 定稿 / 纠偏 / 追加 / 收口后**续跑同一张 DAG**。执行语义（边界判据、`YIELD` 软暂停、晚绑定、成本纪律、被否决项）见 [`执行引擎架构设计.md` §受监督的波循环](/docs/03-AI核心/执行引擎架构设计.md)；此处只记 CEO 侧的工具形态与设计理由。

| 参数 | 语义 |
|---|---|
| `binds` | 把 `bind_after_deps` 占位节点定稿（据上游产出补全 role / task / tools…），定稿后该步即可运行 |
| `steers` | 给【尚未运行】的下游追加操舵说明（同 `plan_review` adjust 机制，运行前注入）；已完成步骤不可操舵 |
| `add` | 追加初始计划没预见的【全新】节点——`build_added_nodes` 管 id 生成（每批新前缀、绝不复用）、依赖接线（可指向现有节点或本批内其它新节点）、拓扑校验（未知依赖 / 重复 id / 超额 / 成环即整批拒绝） |
| `stop` | 确认无需继续——未跑步骤记 SKIPPED、已完成产出交回 CEO 收尾 |

> **all-or-nothing**：一次 `replan` 的 binds + steers + add 先全量校验，任一非法则整批拒绝、暂停计划零改动（`apply_replan`）。
>
> **薄封装、共享账目**：`ReplanTool` 持本回合的 `DelegateTool` 并转发 `DelegateTool.replan`——后者持暂停态（`_supervised`）、校验、in-place 再绑定与续跑驱动；故 worker usage / 账目 / 来源累加在**同一个 `DelegateTool` 实例**上、被回合总账折算，`replan` 自身无账目面。
>
> **被否决**：① 重载 `delegate`（语义混淆「发起新任务」与「续跑旧计划」）；② 复用 `revise`（那是在 worker transcript 上续写、非计划续跑，见 [`多轮编排与队员热修.md`](/docs/03-AI核心/多轮编排与队员热修.md)）——故 `replan` 独立成工具。`add` 早期曾计划推迟，现已与 binds / steers / stop 一并落地。
>
> → 见代码：`tools/builtin/replan.py`、`tools/builtin/delegate/supervised.py`（`apply_replan` / `finalize_stopped` / 边界简报）、`runtime/runs/builder.py`（`build_added_nodes`）。

### `playbook`：固化高频拆解形状 ✅ 已落地

少数**高频、高方差**的拆解形状（如 调研→提纲→写作）从散文指引提升为**可实例化的一等流程**——CEO 实例化而非每次手搓 DAG。`delegate` 加可选 `playbook` + `playbook_args`（与 `tasks` **二选一**；未知名 / 缺必填槽 / 二者同传 → 校验报错；不传则零行为变化）。

- **纯加法、不加子系统**：`runtime/runs/playbooks.py` 一个小注册表（`name → builder(slots) → tasks[]`，纯函数），产出就是 `build_run_plan` 已吃的 tasks 形状，故实例化出的 playbook 走**与手搓完全相同**的管线（`build_run_plan → drive → executor → ceo_format`）。
- **先固化 3 个**：① `research_report`（N×调研 →〔可选 checkpoint〕提纲 → 写作）② `build_feature`（后端接口 →〔前端页面 ‖ 测试〕并行，接口契约经便签墙广播喂给合·对账）③ `compare_options`（N×并行评估 → 汇总对比推荐）。
- **单源不漂移**：schema 的 enum / 槽位说明 + `team_orchestration_advanced` skill 清单都从注册表**单源生成**。
- **防僵化绊线**：只固化这 3 个，不做万能模板引擎；要分支 / 条件 / 每次结构都不同 = 照常手写 `tasks`。
- **铺开姿态（2026-06-30）**：skill 从「仅当…才用」改为「开工前先对一下、是就直接套」（纯提示词、可回退）。

→ 见代码：`runtime/runs/playbooks.py`（注册表 + 3 个 builder）、`tools/builtin/delegate/`（`playbook` / `playbook_args` 校验与展开）。

---

## 二、关键字段设计决策

`delegate` 每个 task 的字段语义见文首代码指针。下表只记录设计理由。

### 2.1 `model_preference` — 执行参数档（非选模型）

CEO 不指定具体模型，只表达能力需求（快/强），由运行时映射到**场景画像的执行参数**（温度、max_rounds 等）——**不换 model**：

| 值 | 含义 | 运行时映射 |
|---|---|---|
| `fast` | 速度/成本优先，简单机械子任务 | `agent.fast` 画像（小轮数预算，温度与 `strong` 相同） |
| `strong` | 质量优先，复杂子任务 | `agent.strong` 画像（大轮数预算） |

设计理由：① 解耦委派与具体模型名，模型更新不改委派逻辑；② `fast`/`strong` 保留场景级执行差异，用户不可见。

**用户统一模型（BYOK）** — 全链路（CEO、worker、辩论辩手）共用用户在「设置·模型配置」配的一个 OpenAI 兼容端点：`api_key` + `base_url` + `default_model`（含 DeepSeek / 各家 / OpenRouter 等中转）。经 `resolve_turn_model` / `resolve_user_chat_model`（`llm/resolve.py`）解析出该 turn 的 model，由 `TurnProfiles.model` 单点持有，**不再按角色或质量档 swap**；场景 profile（`ProfileParams`）只按场景（`chat` / `agent.fast` / `agent.strong` / `memory` / `title` …）分化执行参数（温度/轮数），**不含模型名**，`build_request(model=…)` 显式传入。

- **被否决：质量档矩阵**（`经济档`/`高质量档`、CEO vs worker 分选 Flash/Pro）——多数用户只想「配一个能用的模型」；内测期 Pro 撤出 ceiling 后机制对用户已无价值。质量档解析链、`/v1/model-modes` API、`conversation.model_mode` 与 `users.default_model_mode` 列**均已永久移除**（迁移 drop 表 + 两列）。
- **MVP 约束**：`thinking` / `reasoning_effort` 默认不发（走各家默认行为）；⏳ per-provider 推理字段适配、原生 Claude/Gemini provider 见远期。
- **`supports_tools` soft gate**：probe 测 tool calling，结果作 UI 提示 + preflight warning，**不做 hard 400**——中转兼容性参差不齐，probe 失败不等于端点真不支持；委派/辩论 preflight 返回 warning 后可继续，运行时 `tool_calls` 缺失则 graceful error 提示换模型。
- **后台 one-shot**（memory / title / compaction）：**platform key 优先、BYOK 兜底**——有运营 platform 凭据时不消耗用户 token；仅 BYOK 时走用户 model 并降 temperature / max_tokens。`build_provider(purpose=user_facing|platform_internal)` 区分，不暴露给用户。
- **Provider 路由保留、MVP 不暴露**：`ProviderRouter` 的 `provider/model` 前缀路由供 eval / ⏳ 辩论多模型辩手；MVP 辩论统一用户 model。

→ 见代码：`llm/resolve.py`、`llm/key_service.py`、`llm/factory.py`、`api/routes/llm_key.py`；前端见 [`../04-前端/前端UX设计.md` §十三](/docs/04-前端/前端UX设计.md)、[`../04-前端/前端成本呈现.md` §7.4](/docs/04-前端/前端成本呈现.md)。

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
| `pass_through` | 全文（带共享预算） | 分析/检索→写作链路，须保留金额、法条编号等细节（默认取向） |
| `summarize` | 摘要 | 大扇入合成省 token 的场景 |

> **默认偏全文**：「一律摘要」会丢失关键信息。执行形状由 `depends_on` 自然落定，无需离散计划类型。

> **保真度预算：每 worker 共享 + 水填充 + 首尾保留 ✅ 已落地**：`pass_through` 上游注入时，**每个下游 worker 一份总预算**，在多个 pass_through 依赖间水填充公平分配；超预算时**首尾保留 + 中间省略**（避免尾部关键细节被静默丢弃）。`summarize` 另走紧凑摘要，不占该预算。→ 见代码：`runtime/runs/executor.py`（装配 `_dep_context_blocks`）、`runtime/runs/fidelity.py`（水填充 / 首尾保留原语）、`runtime/runs/constants.py`。

> **递指针不递全文（文件产物）✅ 已落地**：上游已 `file_write` 落盘时，下游注入紧凑摘要 + 文件路径清单 +「需全文请 `file_read`」，不占 `pass_through` 预算。纯文字中间产物仍走全文注入。→ 见代码：`runtime/runs/executor.py`、`runtime/runs/fidelity.py`（`pointer_body`）。

> **CEO 综述输入瘦身：同款保真度用于「全员 → CEO」收尾 ✅**：`delegate` 汇所有 worker 产物给 CEO 写概览时，过去被一道 `output_limit` 盲截（仅留头部）——宽扇出 / 长产物下会**静默丢掉靠后的 worker 乃至本段自带的收尾指令（防幻觉铁律）**，是**正确性缺陷而非单纯成本**。修复：复用上面的保真度纪律到这另一处扇入——**落盘者递指针摘要**（全文在工作区、CEO 需要可 `file_read`）+ **纯文本产物共享一份预算水填充**（超额首尾保留），于是每个 worker 都留有代表、收尾指令必活在 `output_limit` 兜底之下（兜底退为最后保险，常态不触发）。**刻意不按 `result_handling`**——该旋钮只管上游→下游注入、不影响回到 CEO 的内容（见上 §「广度调查归团队」注）。`delegate.synthesis` 埋点用于线上确认兜底常态不触发、校准 `CEO_SYNTHESIS_BUDGET`。→ 见代码：`tools/builtin/delegate/ceo_format.py`（`format_for_ceo`）、`runtime/runs/fidelity.py`、`runtime/runs/constants.py`（`CEO_SYNTHESIS_BUDGET`）。

> **工作区产物清单 ✅ 已落地**：每个 worker 开局注入「队友产物 + 既有文件」去重清单（经 `index_files` 云/本地一致视图），让共享工作区开局可发现；全表受文件数/字符预算封顶；列举失败退化为仅队友产物。→ 见代码：`runtime/runs/executor.py`、`workspace/protocol.py`。

> **并行写隔离：软提示 + 硬守卫 ✅**：同扇出并行兄弟共享工作区、不受文件夹锁约束（任务内小队不锁），而 `file_write` 是覆盖语义——两兄弟写同名路径会互相覆盖。**第一线软提示**：兄弟感知块加一句「各自用不同文件 / 子目录」。**兜底硬守卫**：每批一个 `WriteCoordinator` 记录在飞认领 `path -> run_id`，撞上**同批并行兄弟**已认领的路径则报错引导改名（如 `report-1.md`）——撞名从「丢数据」变成「响错」。**只挡并发兄弟**：下游覆盖 ancestor 产物、CEO 后续批次覆盖前批（不同 coordinator）都不受影响。选冲突守卫而非子目录命名空间：不动共享工作区路径模型、血量最小。→ 见代码：`workspace/write_claims.py`（`WriteCoordinator`）、`runtime/runs/executor.py`、`tools/builtin/file_ops.py`（`FileWriteTool` 守卫）。

### 2.4 `can_delegate` — 嵌套委派（一层）✅ 已落地

`depth < MAX_DELEGATION_DEPTH` 的 worker **默认获** `delegate` + `replan`（`can_delegate` 缺省 `true`）：启动即拥有绑定到**自身为 captain** 的一层子队拆分权，看到子成员产出后自行整合。CEO **不必逐个开启**——明确只需单步完成的叶子任务可设 `can_delegate=false` 显式禁止。

- **硬深度上限 `depth ≤ 2`**（`MAX_DELEGATION_DEPTH`）：CEO（深度 0）→ worker（深度 1）→ sub-worker（深度 2）。depth=2 的 sub-worker **永不获** `delegate`，无论 `can_delegate` 取值——执行器在「发不发工具」这唯一一处卡死，树不可能再深。
- **单 lead 扇出上限 `MAX_WORKER_SUBDELEGATIONS = 4`**：depth-1 worker captain 在一回合内累计最多派出 4 个 sub-worker（跨多次 `delegate` 计数）；CEO 顶层仍受 `MAX_DELEGATION_TASKS`（10）约束。
- **`"auto"` 遗留**：显式 `can_delegate="auto"` 时启动为叶子，经 `request_delegate` 获批后再获 `delegate`（新任务勿用；`request_delegate` 的 70% 轮次预算原硬闸已改为 warning）。
- **账目按树回滚**：嵌套子队的 token 用量与每-run 成本行（`parent_run_id` 指向其上层 worker）逐层上卷到 CEO 顶层 `delegate`，整棵树的花销最终汇入回合总账，不双算、不漏算。
- **并发不爆**：树级并发预算（`MAX_PARALLEL_DELEGATIONS`，ContextVar「分而不乘」）在嵌套 fan-out 下仍封顶，深度 × 扇出不相乘。

> 设计理由：真正的「Agent 团队」需要 captain 能再带队，但无界递归会让成本 / 延迟 / 并发指数爆炸。一层深度上限 + 单 lead 扇出上限是「表达力 vs 可控」的平衡点。**决策演进**：曾默认叶子 + CEO 显式开 / `"auto"` 按需申请——CEO 开局预判谁该带队常不准，涌现式大区块又需要 lead 边干边拆。现改为**启动即默认授予** `delegate`+`replan`（`can_delegate` 缺省 true）+ depth 硬顶 + 单 lead 最多 4 sub-worker + Worker prompt 自律。仍否决：不设上限的自由递归（成本不可预期）。

> **受监督循环对任何 captain 一致（lead 自主 replan 子树）✅ 已落地（B·统一式）**：`can_delegate` 让 lead 能「扇出子队 + 整合」，但**曾只给根 CEO 接线受监督波循环**——`replan` 是绑定到根 `delegate` 的薄包装，lead 拿到 `child_delegate` 却**没配套 `replan`**。后果不是「少个功能」而是**一条可达的断头路**：lead 一旦建出含 `bind_after_deps` 或子 worker `escalate kind=scope`（带未跑下游）的子流水线，子计划会 YIELD 出「请 replan」简报而 lead **接不住 → 死路**，且 YIELD 在 `accumulate_usage` 前 return、已完成子队**漏账**。修复（**给 lead 配 `replan` + 收尾折账**）让受监督循环对**根 CEO 与子 lead 一致**——去掉「只有根能 replan」这个特例（**被否决·A 约束式**：禁 depth≥1 用子计划边界，反而新增「禁 bind/scope」特例、且把涌现式拆解对 lead 关死）。
> - **分层修正（铸厂）**：`runs/` 不可 import 具体 `tools/`，故工厂产一个不透明的 `LeadSubteam` bundle（`delegate` + 绑到该 child 的 `replan` + `dispose` 闭包），由 `tools/builtin/delegate/nesting.py::make_lead_subteam` 在 tools 层铸造，`runs/` 只持 `Tool` 句柄与闭包——去特例同时不破分层。
> - **收尾折账（堵漏）**：`executor_agent.py::_execute_node` 的 `finally` 调 `lead_subteam.dispose()`（→ `child.dispose_open_supervised()`：已完成子队折账、未跑尾记 SKIPPED），时序天然在父 `absorb_children` 之前。
> - **成本不变量逐 captain 守**：lead 的 replan 同遵「回合数 = 真实决策点数、不是波数」；树级并发预算（`MAX_PARALLEL_DELEGATIONS`，ContextVar「分而不乘」）子任务自动继承。**观测不串层**：子层与父层共用同一 `execution_id`，三端 fold 走「同 id → 合并、按 `parent_run_id` 挂树」而非 reset。
> - **何时用 lead**：活里有几个**大、半独立、自身还有内部结构**的区（前端 / 后端 / 数据）；只是几个扁平并行小活则加 lead 是纯开销。深度仍卡 `depth ≤ 2`。
> - **铺开姿态（2026-06-30）**：`_CEO_CORE_HINT` + `team_orchestration_advanced` 已把「碰到大而半独立的区就开 lead、交成果级目标」设为默认（先于 §度量数据、纯提示词可回退）。
> - → 见代码：`tools/builtin/delegate/nesting.py`（`make_lead_subteam`）、`runtime/runs/executor_identities.py`（`LeadSubteam`）、`runtime/runs/executor_agent.py`（depth 门控注册 + `finally` dispose）、`tools/builtin/delegate/tool.py`（`dispose_open_supervised`）；执行语义见 [`执行引擎架构设计.md` §一·受监督的波循环](/docs/03-AI核心/执行引擎架构设计.md)。

### 2.5 `tools` — worker 工具白名单（可选收窄，**缺省 = 全量**）✅

`tools` 是**可选的最小授权收窄**，不是必填白名单：CEO 省略它（常态）时 worker 获得**全部团队工具**，只在要刻意限权时才列子集。

- **缺省即全量（fail-safe）**：`builder._tools` **永不产出 `[]`**——省略 / 只含未知名 → `None`（引擎读作「不限制、提供全部工具」）；非空且经 allow-list 过滤后仍非空 → 该子集。
- **否决「缺省 = 空列表」**：引擎把空 allow-list 读作「不提供任何工具」（`tool_choice="none"`）。一旦把缺省喂成 `[]`，本该 `file_write` 落盘的 worker 会被逼成纯文本 Agent——把整份文件内容吐进聊天、工作区空空，CEO 收尾时还据「文件产出清单为空」误报成功。正确性绝不能押在「CEO 每次都记得枚举 tools」上。
- **revise 一致**：`RunSpec.tools` 落盘为 `list | None`，缺省序列化为 `null`，热修（续写）唤回时还原成「不限制」而非「无工具」。

> 设计理由：worker 能不能干活属正确性、工具收窄属优化，故安全默认必须是「有能力」，least-privilege 由 CEO 主动 opt-in。被否决：要求 CEO 必填 `tools`（依赖 LLM 自觉、脆弱，正是此前 worker 静默不落盘的翻车点）。→ 见代码：`runtime/runs/builder.py` `_tools`、`runtime/runs/types.py` `RunSpec.tools`、`runtime/runs/executor.py`（`None`→offer 全部）。

### 2.6 `completion_criteria` — worker 完工判据（默认 `files_written`，运行/打开类自动升 `code_verified`）✅

worker 任务「怎样算干完」的验收契约，两档：`files_written`（产物落盘即完，**默认**）/ `code_verified`（须真跑通——收尾校验该 worker 确有 `code_execute` / `test_run` 成功记录才放行）。

- **默认低档 + 按 task 语义自动升档**：`DEFAULT_COMPLETION_CRITERIA="files_written"`；task 含「运行 / 打开 / 安装 / 启动」类语义时引擎自动推断为 `code_verified`（CEO 亦可显式声明）。**为何不一律 `code_verified`**：写文档 / 改文案 / 纯配置类任务本不需要「跑」，强制跑通只会平白加一轮、拖慢、甚至让不可运行的任务永远达不成——按语义分流是「交付即验收」与成本的平衡点。
- **对治「写了但跑不起来」**：触发案例（trace `d1bc76f3…`）worker 写出软件却没跑通、CEO 凭记忆答「在 mini-claw/」并口头让用户自己去终端跑；`code_verified` 自动推断 + 收尾校验直接堵住。这是「打开软件」双路径的**路径 A·工作区内验收**（路径 B·本机 OS 启动走 sidecar / Client Tools，见 [`双模式工作区.md` §十](/docs/02-架构/双模式工作区.md)、[`安全权限与治理.md` §三](/docs/05-平台与运维/安全权限与治理.md)）。
- → 见代码：`runtime/runs/completion.py`（`DEFAULT_COMPLETION_CRITERIA` / 推断 / 校验）、`tools/builtin/delegate/schema.py`、`tools/builtin/delegate/drive.py`。

---

## 三、失败处理

| 失败场景 | 处理策略 |
|---------|---------|
| `delegate` 参数非法（无环校验失败、工具未注册、档位非法等） | `build_run_plan` 收集 `errors` 非终态返回 CEO，CEO 改参数重试 |
| 单个 worker 失败 | 按节点 `on_failure`（`skip` / `abort` / `retry`）处理，单 worker 失败不必拖垮整 DAG |
| CEO 判断无需团队 | 不调 `delegate`，直接作答（等价单 Agent，安全兜底） |

---

## 四、开场引导：`ask_user` 开工提案卡 ✅ 已落地

> 开场引导是 `ask_user`（CEO 唯一的「向用户发问」原语）的一种**内容形态**，不是独立工具。→ 见代码：`tools/builtin/ask_user/`、前端 `CheckpointCard.tsx`。

对「**能做、但用户没说全**」的产出类请求（做网站 / 应用 / 海报 / 文档…，且用合理默认就能开工），CEO 不甩一堵澄清问题墙、也不闷头开干，而是调 `ask_user` 开一张**开工提案卡**开场：用自己的口吻复述目标（`message`）、摊开起步计划与少数高杠杆决策，让想省事的人一键开做、想管的人就地调整。

### 决策按「影响力」分档（核心设计）

分档依据是**影响力**而非「是不是技术」——技术决策也可能高杠杆（要不要响应式 / 双语 / 带后台）：

| 档 | 字段 | 语义 | 上限 |
|---|---|---|---|
| 起步计划（安静默认） | `assumptions` | 影响小、可逆、用户多半不关心的决策（框架 / 目录 / 部署 / 命名）。CEO 替用户定好，以「项 + 值」**只读**陈列让其知情（v1 不可改，靠备注框兜底） | 10 |
| 重点问题（主动征询） | `questions` | 真正值得用户拍板的少数高杠杆决策。**每个都预填 `default`**——即便问满上限，想省事的用户一键全默认通过，不退化回问题墙。`kind=choice`（单 / 多选）或 `text`（填一句） | 5 个（对齐 Cursor 2.1 的 3–5）；每问选项 ≤6 |
| 风格基调 | `style_options` | **仅视觉类产物**（网站 / 海报 / 幻灯）给的风格预设供选基调；非视觉类省略 | 6 |

> 判准：决策选错会不会让用户明显不满、甚至推倒重来？会 → 提为重点问题；不会且有稳妥默认 → 放进起步计划默认掉。拿不准时宁可默认掉，别让卡退回问题墙。CEO 只供语义内容（标签 / 选项 / 默认值），工具负责分配稳定 id 并 cap 尺寸，防失控 prompt 撑爆卡片。

### 统一机制：开场与途中共用 `ask_user`；默认挂起、可选非阻塞（核心设计）

`ask_user` 是 CEO **唯一**的发问原语：开场引导与执行途中的高代价岔路用**同一张卡、同一套机制**，沿**内容形态**（开场味 / 途中味）与**是否阻塞**（`blocking`，默认 true）两个正交维度自适应——

| | 开场味 | 途中味 |
|---|---|---|
| 时机 | 回合开场，请求能做但没说全 | 执行途中撞上高代价岔路 |
| 内容 | `message` 复述目标 + `assumptions` 起步计划 + ≤5 预填 `default` 的 `questions` + 视觉类 `style_options` | `message` 说清现状 + 通常一个无 `default` 的 `questions`（就是要用户选） |
| 卡片语气 | 蓝（就绪 / 确认即开做） | 琥珀（待裁决 / 谨慎） |
| 回合 | 默认**挂起**待回值；用户选「停止」结束本回合（也可 `blocking=false` 非阻塞，见下） | 同左 |

**为什么不让模型选「开场工具 vs 途中工具」**：开场 vs 途中是**内容形态**之别，不是机制之别——该结束还是该挂起是**运行时**的职责。挂起 + 恢复是通用情形（保留在途上下文——委派结果、已读文件），开场只是「在途上下文很少」的特例、以可忽略成本被它涵盖。模型只需决定**要不要发问**（克制），不必判别**哪种发问**。

**阻塞与否（`blocking`）则归模型——与上面不矛盾**：开场/途中是伪选择（同一机制的内容差异），而「这个岔路值不值得冻住用户」是**真·语义判断**，只有模型知道自己手上的默认有多稳、岔路猜错代价多大，运行时无从代判。故新增一个正交维度交给模型：默认 `blocking=true`（挂起等答复，用于高风险 / 不可逆 / 无合理默认）；`blocking=false` 时**抛出问题但不挂起**——模型必须在 `assumptions` 或某 `question.default` 写明将先采用的默认（否则该调用被拒，防"非阻塞=偷偷瞎猜"），随即按默认续跑把回合做完，用户回复作为新消息在后续轮次并入。这是 worker `escalate`「问而不停」在 CEO↔用户层的对偶。

阻塞检查点走**挂起即收口**：到点落帧收口回合（`FinishReason.PAUSED`），答复经单一冷路 `POST …/messages/{id}/resume` 续跑（不再 `POST …/interactions` 原地解析）；挂起/续跑契约见 [`执行引擎架构设计.md` §检查点决策语义 / §暂停与恢复](/docs/03-AI核心/执行引擎架构设计.md)。前端卡片见 [`../04-前端/前端UX设计.md`](/docs/04-前端/前端UX设计.md)。

**何时不用 `ask_user`**：简单问答 / 闲聊 / 检索直答——直接答；需求已说全、无值得确认的决策——直接 `delegate` 开干；连意图都不可解（目标都复述不出）——先用一句普通文字问清意图，而不是出卡。

> **被否决**：① **开场即甩问题墙**（故每个重点问题强制预填默认）。② **开场与途中做成两个工具（`kickoff` + `ask_user`）**——统一为单工具 `ask_user`，阻塞与否由 `blocking` 正交维度表达。

---

## 五、检查点与团队预审

**产品触发**：CEO 在关键岔路调 `ask_user`（运行时自决）；DAG 计划在 step 标 `checkpoint_after` 时由调度器波间挂起 `plan_review`。**边界**：`ask_user` = CEO 工具效应；`checkpoint_after` = 计划期声明的结构挂起——语义、2b 续跑、事件契约见 [`执行引擎架构设计.md` §检查点决策语义 / §暂停与恢复](/docs/03-AI核心/执行引擎架构设计.md)。

**团队预审薄预览（✅ 已落地）**：首次顶层 `delegate` 在 `run_plan` 已发出、**首波尚未启动**时，若计划满足「≥2 worker **或** 含辩论标记（`stance`/`round`）」则挂起 `team_preview`（新 Interaction kind，事件对 `team_preview_required` / `team_preview_resolved`）。卡片展示角色 / 任务摘要 / 依赖 / 是否辩论；动作与 `plan_review` 同构——**开做 / 调整（备注注入全部未跑下游）/ 停止**。续跑复用既有 durable Interaction / `POST …/resume` 管线。

**跳过（完成态降噪）**：单 worker + `finalize` 直出；同 CEO 回合内已有阻塞 `ask_user` 且用户已提交确认（journal 含 `checkpoint_resolved`）时跳过，避免双卡。非阻塞 ask 或未 ask → 仍预审。嵌套 `depth>0` / `light` / 续跑（`seed_completed`）不挂。

**与近邻边界**：`team_preview` = 开干前否决权（首波前）；`plan_review` = 波间结构化挂起（`checkpoint_after` 后）；`ask_user` = CEO 主动拍板。三者 kind / 事件 / 卡片分离，勿混用。

**§7.2 Preflight Audit（⏳ 远期）**：有界审计环 / 可编辑改 DAG / Agent 实体化绑定 / 设置项 opt-out **本批不做**——见 [`Agent协作模式.md` §7.2](/docs/03-AI核心/Agent协作模式.md)。

---

## 六、待定事项（Phase 2 及以后）

> 仅列**真残留**；已落地项已迁入各正文，不在此复述（落地即出表）。

| 议题 | 残留 |
|------|------|
| system prompt 内容调试 | 结构（身份+边界）/ 委派判据已落地于提示词管理者职责段（见 §核心定位 / §协调者工具边界、`resolve/prompt.py`）；剩内容调试——worker 角色模板、各系统 Skill 正文实测校准。〔注〕运行期 `delegation_nudge` 软护栏**未落地**——曾试，A/B 实测被无视且净负已移除（见 `loop_controller.py` 过度调查保险丝注释），委派改靠结构性边界决策 + 上述提示词护栏治理，与 [`执行引擎架构设计.md`（§被否决·运行期软护栏）](/docs/03-AI核心/执行引擎架构设计.md) 一致 |
| Agent 实体化 | Phase 1 worker 为内联角色（`agent_id == run_id`）；Phase 2 收敛到 `agent_id` + `AgentResolver` + 委派白名单 |
| 增量声明优化 | 批次预声明 + 跨波重排 + 晚绑定续跑均已落地（见 §一 `replan`）；剩更细粒度的增量重声明 |
| 交互原语回归 | `ask_user` / `plan_review` / `checkpoint_after` / 团队预审薄预览 `team_preview` 已落地（见 §四 / §五）；剩 §7.2 完整 Preflight Audit / 契约闸门 / 治理强制层（远期）⏳ |

---

## 未来优化方向

> 来源：已退役的规划文档「多Agent编排优化-参考Cursor-Multitask」。以下为经评估后暂缓的优化方向，留作未来参考。

### 暂缓项

| 方向 | 内容 | 重新评估时机 |
|---|---|---|
| finalize 单 worker 早释放 | CEO 委派后提前释放 LLM 上下文，worker 完成后再唤回 CEO 写综述 | 需状态落盘续跑能力成熟后 |
| 协调效率指标 | batch_metrics 中增加有效并行度、协调税率等观测指标 | 有真实用户流量后 |
| AutonomyPolicy 可配置 | CEO 按任务设定 worker 自主度档位 | 真实反馈证明需要差异化控制时 |

### 已否决方案

| 方案 | 理由 |
|---|---|
| 替换 CEO 为纯路由器 | CEO 的精细规划能力是 AgentCore 核心壁垒（复杂任务的 DAG 编排 >> Cursor 的单 worker 路由） |
| 前置分类器 LLM | 已否决（每条消息付编排税，见编排器 §聊天优先） |
| Worker 直接通信 | 已否决（成本、不可观测，见协作模式 §二） |
| 取消 CEO 收尾综述 | CEO 的「一个声音」是产品核心体验 |
