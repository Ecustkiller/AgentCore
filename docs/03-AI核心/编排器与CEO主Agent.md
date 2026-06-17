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
| CEO 直接做 | 【对话式回答】：纯问答 / 闲聊 / 解释、只靠检索就能答的请求、分析推理类的**简短回应**——零团队开销，首字即时 |
| 一律委派 | 【交付物】：用户要打开 / 运行 / 编辑 / 保存 / 复用的实质产物（代码 / 应用 / 网页、脚本、配置，以及**成篇**报告 / 分析稿 / 方案 / 文档），哪怕只写一个文件、改一行也派一个 worker，并在 task 里点明「产出物是文件、写进工作区」（成篇文字交付也写成 `.md`） |

> **委派判据：交付物 vs 对话，而非「有没有工具」✅ 已落地**：委派的触发线**不是**「这个我有没有对应工具」——文字产出不需要任何工具，照此画线时凡能用文字表达的活（含本该落盘的代码 / 文档 / 报告）CEO 都会走阻力最小路径自己写完，团队形同虚设（这正是「CEO 大部分内容还自己干」的根因）。正确的线是「产出是**对话式回答**还是**交付物**」：对话式（问答 / 解释 / 检索直答 / 简短分析推理）CEO 直答，保首字即时；交付物（用户要打开 / 运行 / 编辑 / 保存 / 复用的实质产物，**含成篇报告 / 分析稿 / 方案 / 文档**）一律 `delegate` 并在 task 里点明落盘成工作区文件（成篇文字写成 `.md`）。配套**防泄漏铁律**：CEO 绝不为省一次委派把整份代码 / 文件 / 成篇交付贴进正文充数（与 worker 侧 footer 守卫对称）。worker 侧无需改默认形态策略——其「任务明确要求产出文件」分支已能让分析稿按 task 指示落盘，而**中间产物**（注入下游、非最终交付）仍留作文字不落盘。→ 见代码：`runtime/prompt.py` `_CEO_CORE_HINT`、`runtime/skills.py` `team_orchestration_advanced`。

**为什么是档2（被否决：档1「全能 CEO」、档3「纯编排 CEO」）：**

- **档1（CEO 持全套工具，仅复杂任务才委派）**——CEO 上下文易被大块工具输出污染，长会话越来越贵，「团队协作」心智被弱化。
- **档3（CEO 只剩 `delegate`，连检索都过 worker）**——已评估否决：把高频检索也压上 worker 往返，延迟与成本显著上升，且「检索大输出不进 CEO 上下文」已被历史重建原则（工具 I/O 不跨轮回放）基本覆盖。
- **档2 取中**：拿走瘦身最大的两份收益（团队心智 + CEO 上下文洁净），又把「委派税」约束在「只有真正产出 / 变更时才付」，不碰高频只读路径。

> **团队形态判据：双向、调研归团队 ✅ 已落地**：上面的委派判据定「要不要委派」；这条定「委派后团队多大、调研谁来跑」。**① 判据双向**：拆几个看【活的自然结构】而非数量——过度拆碎（连贯串行活拆成互传文件的碎片）与**塌缩成一个**（把天然多文件 / 多角色 / 多视角的交付物压进单 worker 串着做）都是偏差。早期措辞只单向防「过拆」（「别拆碎」「只有…才派多个」），又叠加能力目录里「单 worker delegate 无需 consult」的盖章，把模型系统性推向「单 worker 直出」：实测复杂交付（多文件官网、成篇学术稿）也退化成 `delegate nodes=1`，与「真正的 Agent 团队协作」定位相悖。故补足反向信号 + 落单 worker 前自检 + 拿不准先 `consult_skill(team_orchestration_advanced)`，并清掉散落三处（能力目录 / 常驻核心结尾 / `consult_skill` 工具描述）的「单 worker 无需 consult」措辞。**② 交付级调研归团队**：交付物若需大量调研、且天然分多个独立角度（不同来源 / 子领域、检索 vs 案例 vs 趋势），把各角度作为**并行调研 worker** 一次 `delegate`、用 `depends_on` 汇入下游写手，而非 CEO 自己串行跑完检索、只派一个写手。**这不重开已否决的档3**：CEO 的高频检索（对话式直答 + 开工前轻量探路）仍归 CEO，只有「交付级 + 多角度」的调研腿脚活才扇出——边界仍是档2。→ 见代码：`runtime/prompt.py` `_CEO_CORE_HINT`、`runtime/skills.py` `render_skill_directory`、`tools/builtin/consult_skill.py`。

> **轻量直出（finalize）✅ 已落地**：单 worker 仍跑完整 worker 循环，但当 CEO 判断"本次只派一个 worker、且这次委派即整件事的最终交付"（建个文件 / 改一行）时，可在 `delegate` 设 `finalize=true`——该 worker 成功后其产出**直接作为回合答复**（`ToolEffect.HANDOFF` 终态），省掉 CEO 再写一段概览的合成轮；多 worker 或 worker 失败时自动回落到 CEO 收尾（安全兜底）。worker 用量仍记在工具实例上由 pipeline 折算，终态返回不带 token 以免双计。
>
> **仍待评估**：是否再给 CEO 一条"快速编辑"后门（本地模式对标 Cursor 即时小改），需与"协调者只读边界"权衡——这是另一回事（给 CEO 自己装写工具，已否决的档1方向），留待后续单独决策。

> **产出形态：文件落盘 vs 文字直出 ✅ 已落地**：worker 持全套工具，但「该写文件还是写正文」由其身份提示词按交付【形态】判定——分析 / 审查 / 说明等**可独立阅读的文字**默认直接作为文字产出；可运行代码 / 网页 / 脚本 / 多文件工程等**文件类产物必须 `file_write` 落进工作区**（正文只留摘要 + 路径）。否则 worker 会把整份产物当聊天正文吐出、`file_write` 一次不调，工作区里没有任何文件——用户无法打开 / 运行，工作区快照与文件浏览器（`WorkspacePage`/`FileBrowser`）也无从展示。**新判据下的覆盖**：当成篇报告 / 分析稿作为**最终交付物**时，CEO 会在 task 里点明落盘，命中 worker 形态策略的「任务明确要求产出文件」分支、写成 `.md`（见上 §委派判据）；只有**中间产物**（注入下游、非最终交付）才保持文字默认、不落盘。CEO 侧做**双保险**：委派文件类 / 成篇文字交付任务时在 task 里点明「产出物是文件、请写进工作区」（必要时配 `expected_output`），`ask_user` 开工提案卡开场也说明最终交付是工作区里的实文件。→ 见代码：`runtime/runs/executor.py` `_WORKER_DELIVERABLE_POLICY`（worker 侧）、`runtime/prompt.py` `_CEO_CORE_HINT`、`runtime/skills.py` `asking_the_user`（CEO 侧）。

> **落盘契约门 `requires_files`（软规则 → 可验证代码门）✅ 已落地**：上面的「文件类产物必须落盘」此前**纯靠提示词**，曾失守过（一个「建可运行 HTML」任务产出 46k 字回复、磁盘零文件）。现把它升级为契约门：CEO 在 `delegate` 任务的 `contract.requires_files=true` 声明该交付为文件（**语义判断归模型**——只有它知道这份活该不该产出文件），执行器用**确定性信号** `files_touched`（从 transcript 解析的真实 `file_write`/`str_replace`/`file_move` 调用记录）判定；零落盘即未达标，**复用既有契约门自动返工一次**（反馈「请用 file_write 落盘」），默认非 strict（软提醒不硬退）、`strict=true` 则判该 worker 失败。未声明时行为与之前完全一致（纯文字交付不受影响）。**与 §footer 守卫否决的机械方案区分**：那条否决的是「逐个 worker 扫正文判是否声称写了文件」——对每个 worker 的脆弱内容启发式，触发补丁绊线；本门是**opt-in + 确定性后置条件**，仅在 CEO 显式声明文件交付的 task 上启用，判据是工具调用计数而非语义猜测，故不犯同一忌。这是防御纵深第三层（worker 形态提示词 + footer 守卫 + 本契约门），把「能不能落盘」从「押 worker 听不听话」收成代码可验证、可自修正的硬门。→ 见代码：`runtime/runs/types.py` `RunContract.requires_files`、`runtime/runs/contract.py` `check_contract`、`runtime/runs/executor.py`（`files_touched` → 返工）、`tools/builtin/delegate.py` schema、`runtime/runs/builder.py` `_parse_contract`。

> **CEO 提示词形态：精简核心 + 能力目录 + 按需 consult ✅ 已落地**（提示词瘦身）：CEO 常驻系统提示词只保留「决定干什么」的路由脊柱（身份 + 协调者工具边界 + 单/多 worker 判据 +「worker 看不到对话历史」+「别复述、写综述」+ 进阶档位一行指针），外加一张「能力目录」；「怎么干」的进阶机制——团队编排进阶 / 辩论与交叉审查 / 定向唤回 / 向用户发问（开场引导 + 途中拍板）——做成**系统 Skill**，模型决定要用时才 `consult_skill(name)` 把正文拉回循环。能力目录按「所需工具是否装配」动态显隐（`ask_user` 仅活跃用户路径才列），永不广告 CEO 没有的能力。净效：每轮常驻量从约 6.8k 字降到约 3.1k 字，4 段罕用机制（合计约 4.3k 字）移出热路径、仅在 consult 时进上下文。**分层不变量（防回灌）**：同一条知识只在唯一所有者出现——「何时委派 / 怎么扇出」归 CEO 核心，进阶档位的「怎么用」归对应 Skill，「有哪些能力可拉取」归能力目录；**常驻的工具描述（`delegate` / `consult_skill` / `revise` / `ask_user`）只留机械契约 + 一行指针**，不重教 WHEN/HOW（否则每轮重复计费、且改一处漏一处）；共享基座的 `output_style` 图表段、worker 形态策略同理——只留必要语义，机械细节下沉到对应工具描述 / 代码门（如落盘 `requires_files`）。系统 Skill 的「两类来源、单一机制」与 Prompt 自适应见 [`工具与能力系统.md §二`](/docs/03-AI核心/工具与能力系统.md)。→ 见代码：`runtime/prompt.py`（`_CEO_CORE_HINT` / `CHAT_CITATION_HINT` / `_DEFAULT_SYSTEM_PROMPT`）、`runtime/skills.py`、`tools/builtin/{delegate,consult_skill,revise,ask_user}.py`、`runtime/runs/executor.py` `_WORKER_DELIVERABLE_POLICY`、`runtime/pipeline.py`。

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

> **文件产出清单（收敛免回工作区核对）✅**：`delegate` 折叠回 CEO 的汇总里，每个动过工作区的 worker 附一行「文件产出」——执行器从其 transcript 提取落盘路径（`file_write`/`str_replace`/`file_move` → `RunState.files_touched`，随回合落盘续跑持久化）。这就是本次产物清单，CEO 据此直接收尾、**不必再 `file_list`/`file_read` 回工作区核对**（除非清单为空或明显不全），省掉收敛阶段的冗余目录轮。最佳努力：经 `code_execute` 间接写出的文件不计入，只捕获直接文件工具调用。→ 见代码：`runtime/runs/{executor,serialize}.py`、`tools/builtin/delegate.py` `_format_for_ceo`。
>
> **同一清单兼作防幻觉凭据（footer 守卫）✅**：「文件产出」清单也是 worker 是否真落盘的**唯一地面真相**。`_format_for_ceo` 的 footer 据此立铁律——worker 正文若声称/暗示写了文件却没有该行（清单为空），即判这些文件**未真正写入**：CEO 不得报「已创建/已完成」，应判该文件交付未达成并 `revise` 唤回原作者真正调 `file_write`（或重派）。这是 §2.5「缺省=全量工具」修掉根因后的**防御纵深第二层**，专防个别 Flash worker 仍把 `file_write` 当文本吐出。**刻意做成指令级（交 CEO 判断），不逐个 worker 机械标「未落盘」**：纯文本 worker（调研/分析/辩论）本就无文件产出属正常，机械盲标会误伤、且扫正文判「是否声称写文件」属对账补丁（触发补丁绊线）——清单为空是否危险取决于 worker 有无「声称」，只有 LLM 能判。→ 见代码：`tools/builtin/delegate.py` `_format_for_ceo`。

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
| `strong` | 质量优先，复杂子任务 | Flash（**内测锁 Flash**：质量档机制可提至 Pro，但内测 Pro 已撤出用户 ceiling，见下） |

> 现状：两 worker 档基座均为 Flash（思考 high，靠轮数预算区分，开发期降本）。把 `strong` 提到 Pro 的机制是**质量档**（下文），已取代原 `_STRONG_MODEL` 全局单点翻转（路线图 P1-7）——但**内测（方案 A-中+）已把 Pro 撤出用户 ceiling，用户侧坍缩成单 Flash 档**，整套机制现休眠待恢复。运行参数单一真相源 `llm/config.py`（`PROFILES`、`agent_profile`、`apply_overrides`）。

设计理由：① 解耦委派与具体模型，模型更新不改委派逻辑；② 用户可覆盖映射（即下文质量档）；③ 未来可做智能路由。

**质量档（用户可选模型层，决策② 的落地）** — ⏳ **内测休眠**：机制已完整实现，但内测（方案 A-中+）把 Pro 撤出用户 ceiling、用户侧坍缩成单 Flash 档——质量档/自定义档前端 UI 与 `/v1/model-modes` 路由已下线，预设 / ceiling / `resolve_profile_set` / DB 表整套原地保留（ceiling 加回 Pro 即零迁移恢复）。**Pro 不删**：常量/定价/裁判路径保留，eval 用自有全量 ceiling（解耦于用户 ceiling，见 `evals/harness.py` `_EVAL_CEILING`）仍跑 Flash-vs-Pro 与 Pro 裁判。下文为这套（休眠）机制本身——在 `delegate` 的 fast/strong 抽象之上，用户以**团队语言**为团队选模型，一个「质量档」= 团队角色 → 模型映射，叠加在 `PROFILES` 基座上，**只换 model、不动思考 / 温度 / 轮数**（调参是工程关注点，非用户旋钮）。

- **角色**：CEO 本体（`chat`）/ 主力 worker（`agent.strong`）可配；**经济 worker（`agent.fast`）锁定 Flash**（决策：经济档「按定义就便宜」，升 Pro 自相矛盾）。
- **预设（只读）**：`经济档` = 全程 Flash = 系统默认；`高质量档` = CEO 本体 + 主力 worker 升 Pro（**内测：Pro 不在用户 ceiling，`高质量档`/自定义档对用户不可达、解析时钳到 Flash；`高质量档` 仅 eval 经全量 ceiling 可达**）。用户可在运营 ceiling 内建自定义档。
- **两层合成**：运营 `selectable_models` 设可选模型上限（写入校验 + 解析时 `_clamp_to_ceiling` **双重**钳制，旧档在 ceiling 收紧后仍安全——内测撤 Pro 正是用这把钳子让残留档安全坍缩到 Flash）；用户档在其内取值。
- **解析优先级**：对话 → 用户默认 → 运营默认 → 系统默认（经济）；未知 / 已删档回落经济——模型配置问题**绝不打断回合**（同 `pricing_for` / `get_profile` 的 fail-safe）。
- **纯函数 + 注入**：`resolve_profile_set` 每回合解析出 `ProfileSet` 显式注入流水线（无模块级可变全局），并发回合互不串档。前端设置页 UX（**内测已退役**）见 [`../04-前端/前端UX设计.md` §十三](/docs/04-前端/前端UX设计.md)。

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

> **保真度预算：每 worker 共享 + 水填充 + 首尾保留 ✅ 已落地**：`pass_through` 上游注入下游时的「硬上限」不是「每依赖一刀切」，而是**每个下游 worker 一份总预算**（`DEP_CONTEXT_BUDGET`，与 CEO 读批次产出的 `_DELEGATE_OUTPUT_LIMIT` 对齐——写手综合上游调研，理应与 CEO 综合批次同等的上下文额度），在该 worker 的多个 pass_through 依赖间**水填充公平分配**（小依赖只取所需、余额让给大依赖；单一依赖独享全额）。这修掉两处旧隐患：① 旧的「每依赖 4000 字」对单条长调研过紧、且 N 个依赖会乘成 N×4000 无界膨胀；② 旧的截断是**只砍头部**，把长产物的**尾部**（金额 / 法条编号常在结尾）静默丢弃。现超预算时改**首尾保留 + 中间省略**（`_truncate_head_tail`），与 `pass_through` 的「保真」初衷一致。`summarize` 依赖另走紧凑摘要（`DEP_SUMMARY_CHARS`），不占该预算。→ 见代码：`runtime/runs/constants.py`（`DEP_CONTEXT_BUDGET` / `DEP_SUMMARY_CHARS`）、`runtime/runs/executor.py`（`_dep_context_blocks` / `_allocate` / `_truncate_head_tail`）。

### 2.4 `can_delegate` — 嵌套委派开关（一层）✅ 已落地

worker 默认是**叶子**：拿不到 `delegate`、不能再向下拆。当某子任务复杂到需要它自己带一支小队时，CEO 给该 task 标 `can_delegate=true`，该 worker 才获得一个绑定到**自身为 captain** 的 `delegate`，可再委派一层子团队，看到子成员产出后自行整合。

- **硬深度上限 `depth ≤ 2`**（`MAX_DELEGATION_DEPTH`）：CEO（深度 0）→ worker（深度 1）→ sub-worker（深度 2）。深度 2 的 sub-worker **永不获** `delegate`，即使被标 `can_delegate`——执行器在「发不发工具」这唯一一处卡死，树不可能再深（CEO → worker → sub-worker 封顶）。
- **默认关、显式开**：杜绝「为委派而委派」的失控嵌套，只有 CEO 判断确需二次拆分才开。
- **账目按树回滚**：嵌套子队的 token 用量与每-run 成本行（`parent_run_id` 指向其上层 worker）逐层上卷到 CEO 顶层 `delegate`，整棵树的花销最终汇入回合总账，不双算、不漏算。
- **并发不爆**：树级并发预算（`MAX_PARALLEL_DELEGATIONS`，ContextVar「分而不乘」）在嵌套 fan-out 下仍封顶，深度 × 扇出不相乘。

> 设计理由：真正的「Agent 团队」需要 captain 能再带队，但无界递归会让成本 / 延迟 / 并发指数爆炸。一层上限是「表达力 vs 可控」的平衡点——既覆盖「复杂子任务自带小队」，又把爆炸面钉死在单层。被否决：不设上限的自由递归（成本不可预期）、worker 一律可委派（绝大多数子任务并不需要，徒增开销）。

### 2.5 `tools` — worker 工具白名单（可选收窄，**缺省 = 全量**）✅

`tools` 是**可选的最小授权收窄**，不是必填白名单：CEO 省略它（常态）时 worker 获得**全部团队工具**，只在要刻意限权时才列子集。

- **缺省即全量（fail-safe）**：`builder._tools` **永不产出 `[]`**——省略 / 只含未知名 → `None`（引擎读作「不限制、提供全部工具」）；非空且经 allow-list 过滤后仍非空 → 该子集。
- **否决「缺省 = 空列表」**：引擎把空 allow-list 读作「不提供任何工具」（`tool_choice="none"`）。一旦把缺省喂成 `[]`，本该 `file_write` 落盘的 worker 会被逼成纯文本 Agent——把整份文件内容吐进聊天、工作区空空，CEO 收尾时还据「文件产出清单为空」误报成功。正确性绝不能押在「CEO 每次都记得枚举 tools」上。
- **revise 一致**：`RunSpec.tools` 落盘为 `list | None`，缺省序列化为 `null`，热修（续写）唤回时还原成「不限制」而非「无工具」。

> 设计理由：worker 能不能干活属正确性、工具收窄属优化，故安全默认必须是「有能力」，least-privilege 由 CEO 主动 opt-in。被否决：要求 CEO 必填 `tools`（依赖 LLM 自觉、脆弱，正是此前 worker 静默不落盘的翻车点）。→ 见代码：`runtime/runs/builder.py` `_tools`、`runtime/runs/types.py` `RunSpec.tools`、`runtime/runs/executor.py`（`None`→offer 全部）。

---

## 三、失败处理

| 失败场景 | 处理策略 |
|---------|---------|
| `delegate` 参数非法（无环校验失败、工具未注册、档位非法等） | `build_run_plan` 收集 `errors` 非终态返回 CEO，CEO 改参数重试 |
| 单个 worker 失败 | 按节点 `on_failure`（`skip` / `abort` / `retry`）处理，单 worker 失败不必拖垮整 DAG |
| CEO 判断无需团队 | 不调 `delegate`，直接作答（等价单 Agent，安全兜底） |

---

## 四、开场引导：`ask_user` 开工提案卡 ✅ 已落地

> **状态**：前后端已落地。开场引导是 `ask_user`（CEO 唯一的「向用户发问」原语）的一种**内容形态**，不是独立工具——`runtime.pipeline` 在 CEO 工具面装配 `ask_user`（与 `delegate` 并列），**不**进 `build_builtin_registry`，被委派的 worker 永不向用户开提案卡。**历史**：曾实现成独立的 `kickoff` 工具（开场即终回合、不挂起），开发期已重构并入 `ask_user`（理由见下「被否决」②）。
>
> → 见代码：`apps/server/agentcore/tools/builtin/ask_user.py`、前端 `apps/desktop/src/renderer/components/chat/CheckpointCard.tsx`（统一卡片 `AskUserCard`）

对「**能做、但用户没说全**」的产出类请求（做网站 / 应用 / 海报 / 文档…，且用合理默认就能开工），CEO 不甩一堵澄清问题墙、也不闷头开干，而是调 `ask_user` 开一张**开工提案卡**开场：用自己的口吻复述目标（`message`）、摊开起步计划与少数高杠杆决策，让想省事的人一键开做、想管的人就地调整。

### 决策按「影响力」分档（核心设计）

分档依据是**影响力**而非「是不是技术」——技术决策也可能高杠杆（要不要响应式 / 双语 / 带后台）：

| 档 | 字段 | 语义 | 上限 |
|---|---|---|---|
| 起步计划（安静默认） | `assumptions` | 影响小、可逆、用户多半不关心的决策（框架 / 目录 / 部署 / 命名）。CEO 替用户定好，以「项 + 值」**只读**陈列让其知情（v1 不可改，靠备注框兜底） | 10 |
| 重点问题（主动征询） | `questions` | 真正值得用户拍板的少数高杠杆决策。**每个都预填 `default`**——即便问满上限，想省事的用户一键全默认通过，不退化回问题墙。`kind=choice`（单 / 多选）或 `text`（填一句） | 5 个（对齐 Cursor 2.1 的 3–5）；每问选项 ≤6 |
| 风格基调 | `style_options` | **仅视觉类产物**（网站 / 海报 / 幻灯）给的风格预设供选基调；非视觉类省略 | 6 |

> 判准：决策选错会不会让用户明显不满、甚至推倒重来？会 → 提为重点问题；不会且有稳妥默认 → 放进起步计划默认掉。拿不准时宁可默认掉，别让卡退回问题墙。CEO 只供语义内容（标签 / 选项 / 默认值），工具负责分配稳定 id 并 cap 尺寸，防失控 prompt 撑爆卡片。

### 统一机制：开场与途中共用 `ask_user`、总是挂起（核心设计）

`ask_user` 是 CEO **唯一**的发问原语：开场引导与执行途中的高代价岔路用**同一张卡、同一套挂起 + 恢复机制**，只是**内容形态**不同——

| | 开场味 | 途中味 |
|---|---|---|
| 时机 | 回合开场，请求能做但没说全 | 执行途中撞上高代价岔路 |
| 内容 | `message` 复述目标 + `assumptions` 起步计划 + ≤5 预填 `default` 的 `questions` + 视觉类 `style_options` | `message` 说清现状 + 通常一个无 `default` 的 `questions`（就是要用户选） |
| 卡片语气 | 蓝（就绪 / 确认即开做） | 琥珀（待裁决 / 谨慎） |
| 回合 | 一律**挂起**，待用户回值再续；用户选「停止」才结束本回合 | 同左 |

**为什么不让模型选「开场工具 vs 途中工具」**：该结束还是该挂起是**运行时**的职责，不是模型的。挂起 + 恢复是通用情形（保留在途上下文——委派结果、已读文件），开场只是「在途上下文很少」的特例、以可忽略成本被它涵盖。模型只需决定**要不要发问**（克制），不必判别**哪种发问**。

提交答复是 `ToolEffect.CONTINUE`（CEO 带用户的选择续跑）；停止是 `ToolEffect.INTERACT`——在带内优雅终结本回合的终态效应（收尾语随 `final_text` 落库 + 流式）。问答经 `InteractionRegistry` 挂起、`POST …/interactions/{id}` 回值；卡片骑在 journaled 的 `checkpoint_required` / `checkpoint_resolved` 事件对上，故重载会内联重放完整问答。桌面端把各题选择 + 风格 + 自由补充拼成一段可读 `note`（答复模型 α，唯一读者是 CEO，无需结构化线缆），`selected` 留空。INTERACT 效应与挂起家族的边界见 [`执行引擎架构设计.md` §检查点决策语义](/docs/03-AI核心/执行引擎架构设计.md)；前端卡片渲染见 [`../04-前端/前端UX设计.md`](/docs/04-前端/前端UX设计.md)。

**何时不用 `ask_user`**：简单问答 / 闲聊 / 检索直答——直接答；需求已说全、无值得确认的决策——直接 `delegate` 开干；连意图都不可解（目标都复述不出）——先用一句普通文字问清意图，而不是出卡。

> **被否决**：① **开场即甩问题墙**——高摩擦、劝退想省事的用户，正是开工提案卡要消除的反模式（故每个重点问题强制预填默认，把「问题墙」降维成「一键通过 + 可选微调」）。② **开场与途中实现成两个工具（`kickoff` + `ask_user`）**——逼模型每次先做「该用哪个发问工具」的路由判断，本质是把运行时该管的「结束还是挂起」推给模型、在错误的接缝上让模型选错；开发期已重构为**单工具、单机制**（总是挂起），内容自适应。

---

## 五、检查点与团队预审

**产品触发**：CEO 在关键岔路调 `ask_user`（运行时自决）；DAG 计划在 step 标 `checkpoint_after` 时由调度器波间挂起 `plan_review`。**边界**：`ask_user` = CEO 工具效应；`checkpoint_after` = 计划期声明的结构挂起——语义、2b 续跑、事件契约见 [`执行引擎架构设计.md` §检查点决策语义 / §暂停与恢复](/docs/03-AI核心/执行引擎架构设计.md)。

**团队预审 preflight（⏳ Phase 2）**：执行前团队预览 gate 仍待 preflight 审计回归，与结构化波间挂起是不同议题。

---

## 六、待定事项（Phase 2 及以后）

| 议题 | 说明 |
|------|------|
| CEO / worker system prompt 内容调试 | 「身份 + 边界」结构 + 提示词瘦身（精简核心 + 能力目录 + `consult_skill`）已落地（见 §核心定位）；**CEO 升级判据已从「有没有工具」重画为「交付物 vs 对话」+ 交付物落盘 + 防泄漏铁律**（见 §协调者工具边界）；剩余为内容调试：worker 角色模板、各系统 Skill 正文打磨 |
| Agent 实体化 | Phase 1 worker 为内联角色（`agent_id == run_id`）；Phase 2 收敛到 `agent_id` + `AgentResolver` + 委派白名单 |
| 增量声明优化 | 批次预声明（`run_plan` 带 `parent_run_id`，供图在 run 开跑前成组）+ `run_started` 带 `parent_run_id`/`kind` + **嵌套委派一层均已落地**（见 §2.4）；剩余为更细粒度的增量重声明 / 跨波动态重排（未定） |
| 交互原语回归 | `ask_user` 统一发问（开工提案卡 + 途中拍板，总是挂起）✅ 已落地（见 §四 / §五）；`plan_review` / `checkpoint_after` 波间挂起 ✅ 2a + 持久续跑 2b ✅ 已落地（见 §五）；剩余 preflight / 契约闸门 / 治理强制层（远期）⏳ |
| 多轮编排 | **✅ 已落地**：后续消息沿用 / 修改之前的委派结果——CEO 经 `revise` 唤回原队员带现场记忆续写（内存 + 跨进程落盘留人，双 miss 回落重派），图上挂「修订 vN」版本链。详见 [`多轮编排与队员热修.md`](/docs/03-AI核心/多轮编排与队员热修.md) |
