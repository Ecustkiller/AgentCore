---
status: blueprint
code: apps/desktop/src/renderer/
related:
  - docs/04-前端/前端技术与架构.md
  - docs/03-AI核心/辩论编排设计.md
skip_if:
  - 只改 Store/IPC（读前端技术与架构）
---

# 前端 UX 设计

> **状态**：已确定方向
>
> 本文记录**已落地现状 + 关键决策（含被否决方案）**。工作区/文件模型 → [`双模式工作区`](/docs/02-架构/双模式工作区.md)；`FileSource` 与桌面文件树 → [`前端技术与架构`](/docs/04-前端/前端技术与架构.md) §八。

---

## 核心设计理念

用户心智模型是「掌管一支由 AI CEO 带队的 Agent 团队」（你是老板，团队替你跑），UI 是用户感知这一心智模型的唯一窗口。设计需在「零门槛入门」和「差异化体验」之间取得平衡。设计原则（零门槛、渐进揭示、简单任务零噪音、放大态无损等）贯穿 §一。

---

## 一、全局布局与团队展示

全局采用 **侧栏 + 页面级自定义布局**（详见 [`前端技术与架构.md`](/docs/04-前端/前端技术与架构.md) §五）。核心对话页为单栏聊天区：

```
/conversations/:id（单栏聊天区）
  消息流（多 Agent 回合：助手消息内嵌 InlineTeamGraph）+ ApprovalPrompt（工具审批）
  └ MessageInput（底部固定）
内嵌图状态条「在画布打开」→ 切画布、就地放大该回合（放大态 · CanvasZoomedTurn，含回放 Timeline + 大画布）
点图节点 → 右侧 SidePanel 新开该 run 的详情 tab（被动下钻）；面板是一条扁平 tab 栏——固定首位「工作区」tab（文件/快照）+ 按需的 run 详情 tab。右上「侧面板」开关 / Ctrl+I → 显隐（冷启动落「工作区」tab），Ctrl+J → 直达「工作区」tab
```

**侧栏对话区（IA · 两区混合「方案 B」）**：分上下两区——

- **上·工作区分组**（按文件夹可折叠）：组头显云/本地图标·名称，hover「⋯」/ 右键 = 查看全部对话 / 浏览文件 / **归档全部对话**（批量归档该项目下活跃对话，非 `Folder.archived`）/ **删除项目…**（单入口；两步确认——默认删容器并归档其下对话、云端文件约 30 天清理，链入第二步可彻底删除；与文件页共用 `DeleteProjectDialog`）；组内复用 `ConversationItem` 列 Top 5，超出走「更多」跳 `/conversations` 并聚焦该组。按近活跃排序、组数 ≤6（溢出走「查看全部对话」）；展开态按 `folderId` 持久化（`useSidebarStore`，显式切换优先；无记录默认折叠、唯含当前对话的组自动展开）。
- **下·裸聊扁平列表**（仅未归属文件夹的对话）：置顶优先、当前裸聊对话恒可见；**上限自适应**——无工作区分组时独占侧栏给足 15、有分组时放宽到 10，溢出走「查看全部对话」（侧栏单层外滚，不另设嵌套滚动条）。
- **底部**：「查看全部对话」入口（归档等低频整理在页内左侧筛选「已归档」）。

**对话行操作**：hover 为整理主路径——重命名 + 归档 +「更多」（置顶 / 移到 / 分享 / 导出 / 永久删除）；归档成功 toast 5s 内可撤销；右键菜单同集。批量归档 / 永久删除与「30 天未活跃」快筛仅在 `/conversations`。

**归档 vs 删除**：归档可取消、仅从活跃列表隐藏；删除对用户为永久（后端 soft-delete 保留期不暴露回收站 UI）。

**工作区 ⊥ 裸聊 · 干净二分零重复**：已归属对话只在其工作区组里、**不**在裸聊区重复（**否决**跨区「最近」列表：双显噪音>收益）；裸聊只在下方扁平区（**否决**为裸聊单设「未分组」组：徒增空组噪音）；全部对话都已归属时裸聊区整体隐藏（0 对话走空状态）。**两区无文字标题**——组头（chevron + 图标 + 计数）与裸聊平铺行视觉已足够区分，两区并存以细分隔线隔开。

**决策**：侧栏保持轻量——裸聊 10/15 自适应、每组 Top 5、组数 ≤6，低频整理（完整列表 /「按文件夹筛选 / 页内搜索」）收敛到对话管理页 `/conversations`，文件夹生命周期归「文件」中枢 `/files`；分组逻辑下沉纯函数 `buildWorkspaceGroups`。**「对话」导航即「新建对话」**：点顶部「对话」入口默认开空白草稿（`Ctrl/Cmd+N` 同效），回到旧对话走侧栏列表 /「全部对话」；路由 `/` 是新草稿唯一真相。

→ 见代码 `lib/newConversation.ts`、`pages/ConversationPage.tsx`、`components/sidebar/RecentConversations.tsx`、`components/sidebar/WorkspaceGroups.tsx`、`components/sidebar/WorkspaceGroupHeader.tsx`、`components/folders/DeleteProjectDialog.tsx`、`hooks/useWorkspaceGroups.ts`、`stores/sidebar.ts`、`pages/ConversationsPage.tsx`。

**全局协作感知（跨对话 · ✅ 已落地）**：Agent 团队运行状态不再只在当前对话消息流内可见——

- **侧栏活动横幅** `ActivityBanner`（导航区与工作区列表之间）：订阅**所有**对话的生成态 + 审批态，显示「N 个任务执行中 · M 个待审批」，无活动时不渲染；点开展活跃对话列表、点行跳转（`switchConversation`）。
- **跨对话完成通知**：用户**不在**某对话时，其团队完成 / 失败 / 需审批弹 `notifyInfo` Toast（带「查看」/「去处理」跳转 action）；按对话去重、跳过当前对话与预览/回放路由，不重复弹。
- 纯派生自各 store（会话生成态 + approval），不新增数据通路。→ 见代码 `components/sidebar/ActivityBanner.tsx`、`services/teamActivityNotifications.ts`（接线 `AppShell`）、`lib/teamActivity.ts`（`deriveActiveConversations` / `summarizeActivity`）。

**团队展示并入「思考·正文·工具」时间线**：多 Agent 与单 Agent 回合都走同一条内联时间线（`ProcessTimeline`，§一B）——CEO 的思考、回复正文、工具按真实发生顺序交织。多 Agent 委派时，一张协作图（`InlineTeamGraph`）**内嵌在 `delegate`/`debate` 步的时序位置**承载团队界面：图顶状态条折进了原任务卡片的职责（状态 · N agents · M/M · 用时 · ¥合计 + 救火行），节点 face 只显角色 + 任务/输出 + 用时/工具（¥ / token 归 run 详情，§7.3B），点节点把详情下钻到右侧被动面板，状态条「在画布打开」切画布放大态看大图/回放。CEO 委派前后的思考/正文/自调工具因此围着团队工作按真序排列，不再被压到固定图下方；单 Agent 回合不出图（无团队）。思考逐段可折叠＝零噪音，末段正文即最终答案；live 与重载一致——多 Agent `process[]` 已持久化、经 `journal` 回放，仅持久化前的旧回合回退到独立图布局。→ 见 [`前端技术与架构.md` §9.2–9.6](/docs/04-前端/前端技术与架构.md)。

### 一B、单 Agent「思考·正文·工具」内联时间线 `ProcessTimeline` ✅ 已落地

单 Agent 回合 CEO 直接调工具（联网搜索 / 读网页 / 检索代码 / 执行）时，气泡把 CEO 的**思考、回复正文、工具调用**按**真实发生顺序**交织成**一条内联时间线**（Cursor 式全内联）：思考段＝灰色**可逐段折叠**小块（流式中展开看它边想、完成自动收起＝零噪音），正文段＝正常富文本（含行内引用 `[n]`），工具＝一行（图标 · 中文名 · 参数 · 状态，默认收起、可点开看完整结果；部分慢工具直播完成时自动展开，见下）；**时间上连续的 ≥2 个工具自动 coalesce 成一个可展开组**（`ProcessToolGroup`：摘要头＝分类计数「读取文件 6 · 编辑文件 2」或单类别 ≤3 时直列文件名 · 任一失败显「N 个失败」· 运行中脉冲点；**完成默认收起、流式中尾部活动组展开看它干活**，展开即原样列出各工具行、逐行仍可点开看结果），单个工具维持一行平铺。**末尾那段正文即最终答案**——不再有独立的「底部答案区」，时间线本身就是回复；流式时尾段自带光标 /「正在思考…」。与多 Agent run 详情「思考过程」区段同款折叠交互（§十 run-detail）。

- **决策与理由（为何全内联）**：单 Agent 回合每轮 `思考→正文→工具` 交替（ReAct），**忠实时序优先**——正文回归它在思考/工具间的真实位置；噪音改用「思考逐段折叠」兜。仍被否决的是**常驻、打碎正文的吵闹工具卡**——本方案工具行紧凑、思考可折叠，噪音可控。
- **决策与理由（连续工具折叠 `ProcessToolGroup`）**：CEO 连读 10 个文件曾平铺成 10 行 `读取文件`，满屏噪音。对齐 Cursor「Read N files」/ Claude「Researched…」的行业做法——把**时间上连续、被思考/正文打断即断组**的工具并成一条「动词＋计数」可折叠摘要，**保序**（思考/正文天然作分隔，不打碎时序，故未取「按类别全回合归桶」那种碎序方案）。纯**渲染层 fold**（`lib/processTimeline.ts` 的纯函数 `groupToolRuns` + 桌面 `ProcessToolGroup`），`process[]` 形状不变 → **不动后端 / `turn_journal` / conformance**；**末段正文（最终答案）是 `content` 步、永不进组**，答案绝不会被折叠藏起来。阈值＝连续 ≥2 才折（单个保持平铺）。手机端 `AssistantView` 是另一套实现、本次不含（分组是 chrome、非协议 fold）。
- **完成态整段过程折叠（✅ 已落地）**：回合收场（`!isStreaming`）后，把该回合**所有过程节点**（思考 / 工具 / 工具组）再收进**一行摘要**「思考了 N 步 · 调用了 M 个工具」，点开还原完整时间线；**可见节点**（正文 / 内嵌团队图 / 检查点 / 发问 / 计划复核）始终在外、绝不入折。流式中全展开（边想边看），收场默认收起并按 `messageId` 持久化；单条纯思考（1 步 0 工具）不折。是「思考逐段折叠」之上的**回合级**折叠——前者折单个思考块、本条折整段过程为一行，二者叠加＝完成态默认只见「摘要行 + 最终答案」。→ 见代码 `ProcessTimeline.tsx`（`shouldCollapseProcess` / `formatProcessSummary` / `useStreamAwareDisclosure`）。
- **保序持久化**：时间线随回合持久化（后端落 `turn_journal`，读取投影为 `runs.process` 载荷），刷新可回放。→ 见代码 `components/chat/MessageBubble.tsx`、`services/streamConversation.ts`
- **「正在生成 {工具}…」实时行 `ComposingToolLine`**：CEO captain 拼装大工具调用参数时，时间线尾部一行实时显示「正在生成 {工具} · N 字 ▋」——补 `tool_use_start` 之前的空白期。**纯传输、不持久化**。
- **慢工具等待态（✅ 已落地）**：`web_search` / `read_url` / `code_execute` 等阻塞型工具运行中，工具行除脉冲点外显示后端 `tool_use_progress` 的**诚实阶段**（正在检索 / 抓取网页 / 提取正文 / 执行 / 出网受限 / 排队 / 改用备用引擎…）+ **客户端计时秒数**；`web_search` 额外骨架条预览结果卡形状。阶段事件 **transport-only**（不进 journal / 历史回放），重载后不保留阶段文案；无 phase 时仍显示通用计时。→ 见代码 `ToolLine.tsx`、`constants.ts`（`TOOL_PHASE_TEXT`）、`streamConversation.ts`。
- **结果卡自动展开（✅ 已落地 · 桌面）**：交付物即用户所等内容的工具——`web_search`（搜索命中）、`code_execute`（终端输出）、`file_write` / `str_replace`（diff / 写入预览）——在**直播 running→done 边一次性默认展开**结果卡；手动收起后保持收起。历史回放与手机端不自动展开（手机与 web_search 同款手动展开）。其它工具维持默认收起。→ 见代码 `ToolLine.tsx`（`AUTO_EXPAND_ON_DONE`）。
- **回合结束原因 chip `finishReasonChip`（✅ 已落地）**：回合收尾时气泡**顶部**按 `finish_reason` 挂一枚状态 chip，框住非正常收尾——`max_rounds`（已达最大轮次）/ `degraded`（降级完成·模型多次空响应）/ `unproductive`（无有效进展）三种降级收尾用琥珀 `warning`，用户/断线 `cancelled`（已中断·已保存完成的部分）用 `muted`（遵 `color-tokens.mdc`）；`end_turn` 正常回合不显，`error` 交由错误卡承载（不重复套框）。chip 跨**单 + 多 Agent** 回合（立在时间线/协作图上方）。直播取 `message.finishReason`；**回放**多 Agent 从 journal `runs.finishReason`、单 Agent 从回合级 `turn_end` 回落——非正常收尾的回合即便无图/无进程，也由持久化兜底补写一条最小 `turn_end`，故 `max_rounds`/`degraded`/`unproductive` 重载后照样挂 chip（✅ Tier 2 c）。气泡 hover meta 行另随成本展示回合 token 用量 + 轮次，见 [`前端成本呈现.md §7.3A`](/docs/04-前端/前端成本呈现.md)。
- **回合内联错误卡（✅ 重载回放，Tier 2 a）**：报错回合的 `{code, message}` 直播时走**纯传输** `error` SSE（不入 journal）→ `message.error` 渲染内联错误卡。**重载**则从 `turn_end` 携带的 `error` 投影回 `runs.error` → `toMessage` 映射回 `message.error`，回放同一张卡（含正文为空的报错回合：后端为其补写**空正文消息行 + 最小 journal**，空正文被 history 过滤、不污染后续上下文）。`code` 仍走 `lib/errors.ts` 单点翻译（PIPELINE_ERROR 无补救动作、仅展示）。→ 见代码 `services/messages.ts`（`toMessage`）、`runtime/journal/`（`turn_end` 投影）、`conversation/service.py`（`_persist_turn_result` 反常回合落库门）。

| 形态 | 何时 | 职责 |
|------|------|------|
| 内嵌协作图（主） | 多 Agent 回合，随消息常驻、刷新可回看 | 状态条（进度/成本/救火）+ DAG + 节点用时/工具 |
| 画布放大态（按需） | 点内嵌图状态条「在画布打开」 | 切画布、就地放大该回合：大画布 + 回放 Timeline + 节点详情 |
| 右侧 SidePanel（被动） | 点图 worker 节点新开 run tab；画布点端点新开内容 tab | 一条扁平 tab 栏：固定「工作区」tab + 按需详情 tab（run 全文 / 端点提问·最终回答，可并存对比） |

> 信息分层（Layer 0–4 模型）：单 Agent 回合 = 一条内联「思考·正文·工具」时间线（§一B，思考/工具＝Layer 1–3、末段正文＝Layer 0 输出，按真实顺序交织）；多 Agent 回合 = 内嵌图（Layer 1–3 状态/进度/协作）+ 点节点进面板看 run 全文（Layer 4）。

**聊天特有元素**（检查点 / 非阻塞发问 / 结构化挂起 / 断连续跑 / 工具审批等）→ 见代码 `components/chat/`；消息载入契约见 [`前端技术与架构.md` §9.7](/docs/04-前端/前端技术与架构.md)。**已否决**：Slash 命令、Agent/Team 选择器、产物 Pill、常驻吵闹工具卡（每回合落点 pill 式噪音）、草稿期常驻「自动」chip（改为默认静默 + 可选「归入项目…」，见 §九）。

> 页面宽度 → 见 `.cursor/rules/desktop-layout.mdc`；对话页 / 文件页自有布局除外。

---

## 三、内嵌协作图与状态条（现状）

多 Agent 回合的团队界面是内嵌进助手消息的协作图（`InlineTeamGraph`，→ 见代码 `components/chat/InlineTeamGraph.tsx`）：图顶一条**状态条**按 `execution.status` 分四态渲染，下方是可折叠的协作图（`GraphView` 内嵌形态），状态条「在画布打开」切画布放大态（Route A · `CanvasZoomedTurn`，就地放大该回合、非独立全屏）。状态条吃下了原任务卡片的全部职责（AgentCore 聊天界面与普通对话 AI 的核心视觉差异点）：

- **执行中**（`RunningStrip`）：转圈 + 任务摘要 + 进度 `completed/total` + 进度条；尾部控件（停止 / 折叠图 / 在画布打开）。Agent 状态/工具/输出在下方图节点上呈现；**慢工具诚实阶段（✅ 已落地）**：并行 worker 执行 `web_search` 等阻塞工具时，节点除「运行中」外显示 transport-only 阶段文案（排队中 / 正在检索 / 改用备用引擎…，与 CEO `ToolLine` 同源 `TOOL_PHASE_TEXT`），重载后不保留。
- **已完成**（`CompletedStrip`）：一行战绩「团队完成 · N 个 Agent · M/M 子任务 · 用时 · ¥合计」（用时取帧流挂钟跨度 `elapsedMs`，¥ 取 `message_end` 回合合计 §7.3A）。**部分失败**（CEO 完成但有 worker 失败）额外显示琥珀色「N 个子任务失败」横幅 + 救火行。
- **已停止**（`status=cancelled`）：同战绩形态，「已停止」标题，在跑节点冻结为 cancelled（不再转圈），救火行显示「已花 ¥」。
- **失败**（整轮崩溃，`FailureStrip`）：高亮失败 Agent / run + `run_failed` 错误原因 + 救火行。

救火行（`RecoveryActions`）由失败条、部分失败的已完成条、已停止条共用（✅ 已与 regenerate 分离）：

| 场景 | 主按钮 | 次按钮 | 忽略 |
|---|---|---|---|
| 部分失败（有 worker `failed`） | **重试失败项** → `runRetryFailed`（后端 `retry-failed`，复用已成功 worker） | **全部重新生成** → `runRegenerate` | 清空该回合执行槽 |
| 整轮失败 / 已停止 | **重试** → `runRegenerate` | — | 同上 |

状态条尾部为一级图标按钮：执行中给「停止」、已完成/已停止给「回放」（切画布放大态自动播放时间轴），外加常驻的折叠 /「在画布打开」；不设 `[···]` 菜单——整轮重新执行统一交给消息级「重新生成」与救火行。内嵌图块在 `run_plan` 首次挂载时播放一次入场动画（`animate-task-card-enter`，遵循 `prefers-reduced-motion`，见 `styles/globals.css`）。

**协作图完成态默认收起（✅ 已落地）**：内嵌协作图展开态按 `execution.status` 分流——`running` 展开（实时看团队协作）、收场（`completed` / `cancelled` / `failed`）默认收起（只留状态条战绩摘要降噪）、辩论回合恒收起（全程走放大态「辩论室」，§4.2）；用户手动切换后以其选择为准（`expandedOverride` 优先于默认）。→ 见代码 `InlineTeamGraph.tsx`（`expandedOverride ?? (!isDebateTurn && status === "running")`）。

⏳ **余项**：`RecoveryActions` 的重试/regenerate 仍取 `lastUserMessageId()` 而非 `ExecutionScope`——画布聚焦历史失败回合点重试可能打到最新一轮；「忽略」仅 `clearExecution`、后端无感知。→ 见代码：`StatusStrip.tsx`、`services/turns/regenerate.ts`；后端契约见 [执行引擎 §retry-failed](/docs/03-AI核心/执行引擎架构设计.md)

**出现时机规则**（核心决策）：

| 场景 | 行为 |
|------|------|
| 简单任务（CEO 直接回答，无 plan） | **不出图**，直接流式输出，体验同 ChatGPT |
| 多 Agent 任务（CEO 调用 `delegate`） | `run_plan` 到达时**自动内嵌**于助手消息上方 |
| 任务完成 | 状态条**收缩**为一行战绩摘要 |
| 用户停止任务 | 状态条转「已停止」，在跑节点冻结，提供重试 |
| 用户发新消息 / 刷新 | 每条回答各持自己的执行槽（按 `messageId` §9.3），历史图保留，刷新后从 `message.runs` 回放 |

**为何无「规划中」态**（决策）：CEO + `delegate` 架构下 `run_plan` 同步到达，无独立规划空窗；「系统在思考」由 CEO reasoning 气泡覆盖；`tool_use_start(delegate)` 前无法预知是否组团，故状态条不设「规划中」态。→ 见代码 `tools/builtin/delegate/`、`runtime/engine/`。

**中间可见性（✅ Phase 1 · ⏳ Phase 2a 后端）**：并行 worker 产出经 `run_output_delta` fold 到 `agent.outputChunks`；协作图节点 `AgentNodeActivity` 显示 `livePreview`；侧栏 `RunDetailBody` 流式 Markdown。**审查预警**：`lib/reviewConcern.ts` 解析 `7/10`、方向类措辞 → 节点「待关注 / 方向风险」琥珀/红徽章。**一键下钻**：`StatusStrip`「查看进行中」→ 打开首个 running worker 侧栏；`RunDetailBody` 进行中提示流式更新 +「记下改法」预填输入框 +「停止整轮」。**跑一半改方向**：`RunDetailBody`「立即改此人」（Step 1 交互 ✅；scheduler 单人取消 + 冷重跑 ⏳，见 [`多轮编排与队员热修.md` §十](/docs/03-AI核心/多轮编排与队员热修.md)）。**团队便签**：协作图下 `TeamNotesPanel`；有便签时状态条「团队便签 N」徽章（见 [`Agent协作模式.md` §便签墙](/docs/03-AI核心/Agent协作模式.md)）。

→ 见代码：`lib/reviewConcern.ts`、`StatusStrip.tsx`、`RunDetailBody.tsx`、`agentNode/*`、`TeamNotesPanel.tsx`。

**检查点卡片（已落地）**：CEO 调 `ask_user`（默认 `blocking=true`）暂停回合、请用户拍板——会话流内独立卡片，刷新后随消息回放。**语气按内容自适应**：开场味 = 蓝 `primary`／「就这样开做」；途中味 = 琥珀 `warning`／「提交」。两动作：**提交**续跑 / **停止**优雅结束本回合。卡片仅在 live 挂起时可操作，历史回合只读。

→ 见代码 `components/chat/CheckpointCard.tsx`（`AskUserCard`）；语义与 API 见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

> **为何两态而非三态**（决策理由）：「继续/调整」效果同一，合并为「提交」；保留「停止」安全阀。详见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

**非阻塞发问卡片 `NonBlockingAskCard`（✅ 已落地）**：CEO 调 `ask_user(blocking=false)` 时**不挂起回合**——语气取**品牌蓝 `primary`**，展示问题 + 默认假设 + 选项 **回填 chips**（点 chip 写进输入框，随下一条消息发回）。从不挂起、无 pending/resolved 态。

→ 见代码 `components/chat/NonBlockingAskCard.tsx`；语义见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

**结构化挂起卡片 `PlanReviewCard`（✅ 已落地）**：DAG step 带 `checkpoint_after` 时，调度器在**波间**暂停——区别于 CEO 主动 `ask_user`（`kind=plan_review`）。卡片展示已完成步骤 + 待运行下游预览；**继续 / 调整 / 停止** 三按钮（`adjust` 备注注入未跑下游，仅备注非空时可点）。三态：**pending** / **dormant** / **resolved**。

→ 见代码 `components/chat/PlanReviewCard.tsx`；语义见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

**统一团队时间线 · 卡片落点（✅ 已落地）**：上述「某一时刻发生」的交互卡片——检查点 / 非阻塞发问 / 计划复核 / **队员升级求决策**（`EscalationCard`）——不再统一堆在气泡最底部，而是按真实时序内联在回合时间线（`ProcessTimeline`，§一B）上。CEO 自调的检查点 / 发问 / 复核各在其事件处落一枚零宽 `process` 标记（`checkpoint` / `ask` / `plan_review`），卡片在标记槽位回放；**队员升级是执行级时刻**（worker 在团队执行内 `escalate`，并非 CEO 的某一步），故不另发标记，而是随**团队执行槽**渲染——紧贴协作图（`team` 标记）之下、在 CEO 收尾答案**之前**，与它所属的团队执行同处。两形态都落此槽位：阻塞 `pending` = 可拍板卡，非阻塞 `raised` =「边干边上报」轻提示（无需拍板、不计入待决数），后者补齐「折叠协作图后队员上报仍可见」的「升级实时可见」。仅持久化前、无标记的旧回合回退到底部堆叠（绝不双渲染）。**回合级汇总**（引用来源 `SourceCards`、文件产物 `FileArtifactsCard`）仍留答案下方——它们是整轮的参考书目 / 交付物清单、非某一时刻事件（单次文件写入本身已作为工具步内联）。→ 见代码 `components/chat/message-bubble/ProcessTimeline.tsx`、`AssistantMessage.tsx`、`lib/processTimeline.ts`。

**断连续跑卡片 `ResumePrompt`（✅ 已落地）**：结构化挂起回合断连/重启后，渲染在**输入框上方**的「待恢复」卡片（内容同 `PlanReviewCard` 或 `AskUserCard`），**继续 / 调整 / 停止** → `POST …/messages/{mid}/resume` 走 SSE 续跑。

→ 见代码 `components/chat/ResumePrompt.tsx`；语义见 [`执行引擎架构设计.md` §暂停与恢复](/docs/03-AI核心/执行引擎架构设计.md)、[`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

> **勿与两个近邻混淆**：① **工具审批**（`approval_required`，GRANTABLE 工具授权）是另一套、渲染在输入框上方而非消息内；② **CEO 主动 `ask_user`** 与 **DAG `checkpoint_after` 结构化挂起**是不同机制（前者 CEO 运行时自决，后者调度器波间闸门）——二者 UI 形态相似但数据通路与 resolve kind 分离。`TeamPreviewCard` 团队预审 gate（执行前预览团队）仍 ⏳ Phase 2 preflight，见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

---

## 四、辩论/审查范式

> ✅ **已落地**：辩论从「`stance`/`round` 展示标记 + CEO 手搓 DAG」升级为「**主持人（Moderator）驱动的逐轮交锋 → 决策简报 + 交锋叙事线双产物**」。完整编排（主持人循环 / 三形态 / 收敛 / 逐轮交互 / 补轮 / 站队会话内态）见 [`辩论编排设计.md`](/docs/03-AI核心/辩论编排设计.md) §六–§七；本节聚焦**前端呈现**。
>
> ✅ **前端重构已落地（2026-07-06）**：交锋叙事前端从「IM 群聊单流 `DebateStream`」**重建为「辩论室：赛事页」**——记分牌 + 阶段化剧本主列 + 终审舞台三层结构；live 与收场仍是同一条 `toDebateModel` 归一流、无 phase 切换。主视图 `DebateArena`（`DebateStream` 为兼容别名），右坞「辩论裁判台」已解散。行为契约见 §4.1，组件去向见 §4.1b。

### 4.1 辩论室：赛事页（✅ 已落地）

把整场辩论呈现为**体育赛事直播页 + 法庭记录**——三层纵向结构，入口仍为画布放大态「辩论室」（状态条**「打开辩论室」CTA** → `CanvasZoomedTurn`）。

| 层 | 组件 | 职责 |
|---|---|---|
| **记分牌** | `arena/Scoreboard` | 页首记分牌（**随内容滚动**，不占 sticky 屏）：辩题 / 形态 / 轮次进度 / 章节锚点；正反 VS 阵营 + **模型徽章（全页仅此一处常驻）** + 累计比分 + momentum 微图；红队风险盘口 / 圆桌阵营平铺；**布局开关 `LayoutToggle`**（并排 / 单栏，仅正反）+ **站队控件** `StanceControl` |
| **剧本主列** | `arena/Transcript` | 逐轮 `SectionHeader` → `SpeakerBlock`（立论/续辩/答问/结辩，身份色轨 + 阶段词，**无模型徽章**）→ `JudgeNote`（主持人小结 + 逐轮净分 chip）→ `CrossExamSection`（质询 Q→A）→ 直播末 `SteeringPanel`（掌舵三选一 + 追问） |
| **终审舞台** | `arena/FinaleStage` | 强分隔进入舞台区：「主持人终审」头（**模型徽章** + 收场原因 + 裁决过程钻取）→ 倾向 `text-xl` + 置信 + 胜负手/争点 → `brief/` 简报体（含「双方一眼看」`SidePointsGrid`、圆桌光谱、风险清单等）→ 终盘比分条 → 站队软对照 → `DebateContinue` |

**已确认决策（沿用）**：

| 维度 | 决策 | 要点 |
|---|---|---|
| **布局** | 赛事页 `max-w-7xl`；正反两方默认**左右并排**（正方左 / 反方右）、记分牌「布局」开关可切 `max-w-3xl` 单栏；红队 / 圆桌恒单栏 | 对抗感靠**阵营色 + 身份色轨 + 记分牌 VS 对垒 + 引用回复**（`ReplyQuote`）；正反另提供**可选左右并排**（仅逐轮发言分栏，轮头 / 质询 / 裁判札记通栏），偏好持久化、长文可随时切单栏 |
| **单流** | 直播与收场同一条流，轮次=章节锚 | 收场 = 主列跑完追加 `FinaleStage`，不是另一个视图 |
| **结论** | 流末「主持人终审」= 唯一结论面 | 记分牌提供「终审 ↓」锚滚动至 `FinaleStage` |
| **落点** | 画布放大态唯一内容主视图 | 辩论回合无平级 tab；协作图仍为头部浮层（`graphOverlay`，§6.5） |
| **记分牌滚动** | 不 sticky | 长文阅读优先：记分牌随剧本滚走；章节 chips / 比分回顶可见，放大态顶栏仍保留任务摘要 |

> **阵营色 = 辩论对立 token（决策·2026-07）**：正反 2 方按语义 key 定死红蓝对垒（`pro=蓝` / `con=红`），专用 token 独立于 `--agent-N` 身份色板；多方（圆桌 / 红队 / subject）仍按名字 hash 分色。→ `debate/model.ts` `debateSideColorVar`（`Scoreboard` / `SpeakerBlock` / `brief/` 同源消费）。

**行为契约（赛事页）**：

| 概念 | 呈现 |
|---|---|
| 辩手发言 | `SpeakerBlock`：左 3px 身份色轨 + 名字 + 阶段词 + 流式/异常态；正文全宽 `Markdown evidence` + `CollapsibleSpeech` 折叠；**无头像圈、无模型徽章** |
| 轮次 | `SectionHeader`：轮号 + 焦点 + 章节锚 |
| 主持人小结 | `JudgeNote`：法槌标 + 小结 + 收敛/交锋信号 + 逐轮净分 chip |
| L3 交锋 | `ReplyQuote`：反驳方发言顶部「↩ 回 X：要点」 |
| 质询 | `CrossExamSection`：Q→A 对（默认折叠，teaser 显未答数） |
| 用户追问 | `UserInterjection`：右侧条 + 定向 chip；收场标「已承接」 |
| 站队 | **记分牌** `StanceControl`（正反 VS 行旁）；会话内态、不持久化 |
| 掌舵 | 直播末 `SteeringPanel`（三选一 + 追问 composer）；复盘 fallback 文案 |
| 决策简报 / 裁决 | `FinaleStage` + `brief/BriefCard`：倾向头条 + 次级区块全展平 |
| 续辩 | `DebateContinue`「换个角度再辩」 |

**约束**：纯前端渲染层重构，**不动协议 fold / conformance**——`toDebateModel` 读 `execution`、已归一 live+收场（守 [`protocol-conformance.mdc`](/.cursor/rules/protocol-conformance.mdc)）。

→ 见代码：`components/chat/debate/arena/`（`DebateArena` 壳 + `Scoreboard` / `Transcript` / `SpeakerBlock` / `JudgeNote` / `CrossExamSection` / `SteeringPanel` / `FinaleStage` / `ClosingBlocks` / `brief/`）+ `DebateStream.tsx`（`DebateArena` 兼容导出）+ `graph/CanvasZoomedTurn.tsx`。

### 4.1b 旧范式退场与组件去向（✅ 已完成）

**旧范式（已退场）**：直播 `LiveChat` 群聊气泡、复盘 `Arena` 擂台左右对开（2方）/ `Narrative` 时间线（多方）、终局裁决 hero（`GavelCard`/`YourVerdictHero` 等）浮顶 + 可展开复盘，`DebateCompare.tsx` 按 `model.settled` 分相位；其后一度收敛为「统一辩论室（IM 群聊）」`DebateStream` + 右坞 `DebateHudRegion` 裁判台。问题：群聊隐喻表达不了阶段/比分/裁决、右坞与 run 详情抢宽。已由 §4.1 **赛事页 `arena/`** 替代。

**组件去向**：~10 套范式 → **赛事页三层**（✅ 已落地）。下表为历史去向；**现行组件树** → `arena/DebateArena`（`Scoreboard` + `Transcript` + `FinaleStage` + `brief/`），旧 IM 群聊 / 裁判台组件已由 `arena/` 取代。

| 现组件 | 去向 |
|---|---|
| `LiveChat` | ✅ 删 → 曾升为 IM 主视图 `DebateStream`；2026-07-06 再由 `arena/DebateArena` 取代 |
| `Arena`（擂台） | ✅ 删 → 旧擂台组件退场；左右并排后由 `Transcript` 逐轮发言分栏重做（可选布局，2026-07-07） |
| `Narrative` + `ConvergenceBand` | ✅ 删（收敛信号入 `JudgeNote` / `SectionHeader`） |
| `Brief`（`BriefCard`/`RoundtableSpectrum`） | ✅ 迁 → `arena/brief/`，嵌入 `FinaleStage` |
| `GavelCard`/`YourVerdictHero`/`AIVerdictCollapsible` | ✅ 删 → 拍板功能整体移除（2026-06，§4.4） |
| `ArgMap` | ✅ 删（视图过多收口） |
| `DebateRoundDecisionCard` / `SteeringBar` / `DebateHud` / `DebateHudRegion` | ✅ 删 → 掌舵归 `arena/SteeringPanel`（主列流末）；记分/阵营/站队归 `arena/Scoreboard`；右坞裁判台解散 |
| `StanceBar`/`UserTake`/`StanceVote` | ✅ 删 → 站队归记分牌 `StanceControl`（§4.4） |
| `Interjections` | ✅ 删 → 追问归 `arena/UserInterjection` |
| `Continue`（`DebateContinue`） | ✅ 保留 → `FinaleStage` 底栏「换角度再辩」 |
| `FlowToolbar`（流式/并排） | ✅ 删 → 全局流式/并排开关废弃；并排后由记分牌「布局」开关（仅正反 · 可切单栏）重做（2026-07-07） |

净效：主视图 `DebateArena`（记分牌 + 剧本主列 + 终审舞台）；放大态辩论回合无平级 tab，协作图仍为头部浮层（`graphOverlay`，§6.5）。

→ 见代码：`components/chat/debate/arena/` + `DebateStream.tsx`（`DebateArena` 兼容导出）+ `graph/CanvasZoomedTurn.tsx` + 手机 `apps/mobile/src/components/DebateView.tsx`（精简镜像）。

### 4.2 团队图上的辩论标记（✅）

差异化呈现（仅辩论回合触发，普通并行批次零变化）：

| 处 | 现状 |
|----|------|
| 范式标题 | 内嵌图状态条显「辩论」pill、完成态作「辩论完成」（普通为「团队完成」）——`InlineTeamGraph`（`isDebate` = 有 `debate` 产物或有 `stance` runs） |
| 节点 badge | 对立节点显「正方/反方」徽章（`primary` 令牌，与 6 态状态色解耦）——`AgentNode` |
| 图分列对置 | 正/反节点按 `stance` 排序 + ELK `considerModelOrder`，分两带对置——`GraphView` / `lib/elk-layout.ts` |
| 节点层级 | CEO（主气泡，不进图）→ 主持人（完成态节点）→ 辩手（挂主持人下），见 [`辩论编排设计.md §7.3`](/docs/03-AI核心/辩论编排设计.md) |
| 辩论全程 | **不内联聊天**——辩论全程（逐轮发言 + 决策简报 + 交锋，§4.1）归画布放大态「辩论室：赛事页」主视图；**辩论回合聊天占位精简**：内嵌协作图**默认收起**、入口换成**醒目「打开辩论室」CTA**；live 与收场是同一条流、无跳跃——`DebateArena`（在 `CanvasZoomedTurn`，`debate/model.ts` 归一 live+收场） |

### 4.3 老板介入、追问与续辩（✅）

辩论中途介入**复用** [`辩论编排设计.md §六`](/docs/03-AI核心/辩论编排设计.md) 的 opt-in 逐轮交互（进程内挂起 `DEBATE_ROUND` + 主列流末 `SteeringPanel`）：

| 动作 | 前端落点 |
|---|---|
| 继续辩 / 按此角度继续 / 够了出结论 | `SteeringPanel` 三选一 → `resolveInteraction` |
| **追问**某方/全场 | `SteeringPanel` 的【追问输入 + 定向 chip】与决策一并提交（`ask`/`ask_target`）；复盘在 `UserInterjection`（手机 `DebateView` 只读复盘）渲染「你的追问·是否被承接」。追问输入为**桌面端能力**（手机只读复盘） |
| **续辩**（可逆叫停） | `FinaleStage` 底栏 `DebateContinue`「换个角度再辩一轮」→ `debate_seed` 新回合（`Continue.tsx` / `seed.ts` / `sendDebateContinuation`） |

逐轮决策卡 transport-only → 重载不复现（选择已体现在实际轮次 + `debate_result`）；追问 verbatim 进 `user_interjections` 可重载复盘。

> ✅ 已落地（§4.1）：三选一 + 追问 = 直播态 `arena/SteeringPanel`；复盘追问 = `arena/UserInterjection`。

### 4.4 站队（✅ · 会话内态）

用户侧轻量标注，**绝不改 AI 裁决内容**（守中立：站队只对比）。store `debateUserTake.ts`（按 `turnId` 分桶）+ 记分牌 `StanceControl`（落点见 §4.1）：

- **站队** `StanceControl`（记分牌正反 VS 行旁）：点选某方记倾向（身份色高亮、仅你可见·不影响 AI 裁决）；终局在 `FinaleStage` 附「你 vs AI」软对照（`leaning` 文本含该方名→看似一致，只提示不下硬判）。
- **会话内态、不持久化**：站队仅在当前打开的会话有效，重载 / 翻页即重置（轻量倾向标记，不值得专用持久化基建）。

> **「用户拍板」(gavel) 已移除（2026-06）**：原置顶结论卡展开区的 `GavelActions`（对价值之争选一方上位 / 维持 AI 裁决，并落 `debate_user_takes` 表跨重载持久化）整体删除——纯客户端标注无人消费、与站队职责重叠、专用持久化基建与价值不相称（详见 [`辩论编排设计.md §6.7`](/docs/03-AI核心/辩论编排设计.md)）。要据结论推进，直接对 CEO 下指令或「换角度再辩」（§4.3）。

### 4.5 论证地图透镜（已移除）

曾把辩论读成节点（各方 + 最强主张）+ 有向边（各轮 `clashes` 谁驳谁）的 `ArgMap` 次级透镜，**已随「视图过多」收口移除**（2026-06）。攻防结构的逐轮交锋仍可在赛事页 `ReplyQuote` + 记分牌 VS 对垒读到。放大态辩论视图现为 **赛事页（唯一内容主视图）+ 协作图浮层**（头部按钮唤出），见 §4.1b / §6.5。

> **决策演进**：「主持人是 CEO 之下、辩手之上的一层、底层无 debate 专用执行路径」**仍成立**——只是这层落成 `debate` 工具内的确定性循环 + 图上完成态节点，而非一个 LLM 委派角色。旧「多轮 = CEO 手搓跨轮 DAG」**被替代**，见 [`辩论编排设计.md §八`](/docs/03-AI核心/辩论编排设计.md)。

---

## 五、图视图（现状）

**内嵌静态 + 画布放大态探索**（核心 UX 规则）：内嵌 `GraphView`（`embedded` 形态）为**静态预览**——禁缩放交互，滚动对话而非缩放画布；状态条「在画布打开」切画布放大态（`CanvasZoomedTurn`）做缩放/平移/回放。内嵌 fit-to-width 定高，节点 face 三层：角色 → 在干什么 → 用时（**工具次数归 hover 速览卡 / run 详情**；**¥ / token 归 run 详情**，§7.3B）。点节点下钻：内嵌图开右坞 `SidePanel` run 详情 tab；**放大态点 worker 同样走右坞 `SidePanel` run 详情——复用同一 `sidePanel` store（节点高亮、退出放大态后右坞仍展示同一 run），端点（用户输入 / CEO 汇聚点）同样开到右坞 `SidePanel`——作「内容 tab」渲染提问 / 最终回答正文（是气泡非 run，故另立 tab 类；画布无气泡陪同，最终回答首入自动开一次）。详情一律向右开、不退出放大态；Esc 渐进收起（先收右坞面板、再退放大态）。内容 tab 是画布专属——离开画布阅读上下文（退放大态 / 切回聊天）自动清掉、run tab 保留，故答案不与对话气泡重复。内嵌图的端点点击仍跳对话气泡（气泡就在阅读列内，无需面板）**。

→ 见代码 `components/graph/GraphView.tsx`、`components/graph/`

**嵌套子团队 · 子队盒**：子 worker 经虚线委派边挂父 worker 下、带「子任务」徽章，并由 ELK compound 包成一个虚线**子队盒**（`SubTeamGroupNode`，标「X 子队 · N 人」）；嵌套委派 → 盒中盒。**修订轮归属子队（布局不变量）**：被盒住的成员若有续写轮（辩论/圆桌逐轮＝修订 `revision≥2`），整条修订链归入**同一子队盒**并按网格排（参与者＝行 / 轮次＝列）；归属沿**修订根**解析，须在「归属判定 / compound 子节点 / bbox / 投影 `parentId`」四处一致——否则修订会逃逸到盒外、在框外自成一层，与源之间空出一列 phantom gap（历史 bug）。→ 见代码 `lib/elk-layout.ts`（compound + `containsTeam` 修订感知；网格由 compound 内修订边直接排出，参与者＝行 / 轮次＝列）、`components/graph/projectFlowGraph.ts`（修订解析到修订根挂 `parentId`）、`components/graph/SubTeamGroupNode.tsx`。

**角色身份（✅ 已落地）**：每个队员节点的头像 = 按角色名**稳定派生**的「颜色 + 首字字形」（`lib/agentIdentity.ts` 用 FNV hash → `--agent-1..8` 身份色板，CJK 角色名首字即天然字号头像「研/工/设」），让一支团队读作「一个个人」而非一排同款 Bot 图标。**身份与状态解耦**：身份在头像盘，运行状态走卡片色环 + 头像角标的「在线点」（运行/完成/失败带小字形，保留非颜色线索），故身份色永不与 6 态状态色抢色（见 `.cursor/rules/color-tokens.mdc`「分类色板」）。

**信息流边（✅ 已落地）**：队员间的依赖边不再只表「先后」，而是据下游 run 的 `receivedContext`（按 `source_run_id` 精确匹配上游产物块）标注**真实交接**——仅在**有损**交接（`摘要` / `递指针` / `截断`）时挂一枚小标签，`全文`（pass_through）交接保持干净线，故标签精准落在「队友只拿到了不完整产物」处；hover 标签看「来自 X · 保真度 · N 字 · 是否截断」。纯渲染层派生（`GraphView` `flowEdges` + `StepEdge` 的 `EdgeLabelRenderer`），**不改协议 fold / conformance**。

**审计数据流高亮（✅ Phase 2）**：多 Agent 回合经 `useTurnAudit` 读 `causal_graph` inject 边——**打开某 run 详情时**（`litRunId`）高亮该 run 的 inject 入/出邻域（与 dep 重合则加粗原箭头、不画二线；仅 audit 有 inject 时补虚线）；其余边/节点变淡。工具栏可选 toggle「始终显示审计数据流」（默认关）。与 run 详情「数据从哪来」同源。→ 见代码 `lib/causalInject.ts` · `GraphView.tsx` · `StepEdge.tsx`。

**波次泳道（✅ 已落地）**：协作图按 `WaveScheduler` 波次（ELK 同层 = 同波）在节点后方画半透明泳道 + 「第 N 波」标签，让「团队分轮推进（并行扇出 → 汇总 → …）」一眼可读；**单波（纯并行扇出）/ 单 Agent 不出泳道**，简单回合保持干净；端点（用户输入 / CEO 汇聚点）在泳道之外。经 `ViewportPortal` 在画布坐标系渲染（泳道 z-index -1 沉底、标签浮顶），随平移/缩放联动。→ 见代码 `components/graph/GraphView.tsx`（`computeWaves`）。

**hover 速览卡（✅ 已落地）**：hover 队员节点弹一张**比 face 更详、比右侧面板更轻**的速览（角色 + 状态 + 分类标记 + 任务 + 更长的「在做 / 产出」预览 + 模型·token·用时·工具 一行），补「节点 face → 完整面板」之间的渐进披露层；复用 face 同源信号、只给更多空间，不新增数据通路。模型档/深度的小徽标 tooltip 已并入此速览（避免节点内嵌套 tooltip）。→ 见代码 `components/graph/AgentNode.tsx`。

**产物落点 chip（✅ 已落地）**：节点据自身**已提交**的文件工具调用（`file_write` / `str_replace`，按 `path` 去重、保首写顺序）派生「这个队员产出了哪些文件」，在 face 上挂文件 chip（📄 + 文件名，face 最多 2 个 + 「+N」溢出，hover chip 看全路径），速览卡列更多（至多 6 + 溢出）、aria-label 播报「产物 N 个」。**只算 `success` 调用**（失败/中止的写入不落产物），且与中行的「正在生成」分离——chip 是已落盘成果，中行是进行中的写入；纯渲染层派生（`GraphView` `deriveArtifacts`），不改协议。→ 见代码 `components/graph/GraphView.tsx`（`deriveArtifacts`）、`components/graph/AgentNode.tsx`。

**可达性与多选**：节点 `role=button` + `tabIndex` 键盘 focus + Enter/Space 激活 + `aria-label` 播报角色/状态/模型/Token/成本/用时/工具/产物；支持多选（修饰键加选 / 框选，`selected` 与面板下钻高亮共用 outline）。**动画 / 布局选型理由**：状态过渡用纯 CSS（**否决 Framer Motion**——零依赖、与 React Flow 定位 transform 无冲突）；ELK 仅留左右流 / 树形（径向 / 力导向曾实现、小团队下无价值已移除）；右键菜单复用 `sidebar/ContextMenu`（无需 Radix）。

**结构化挂起图徽标（✅ 已落地，Phase 2a）**：`plan_review_*` 事件入 journal 后，execution fold 按 step `run_id` 折进 `RunNode`；在检查点步骤的 `AgentNode` 上挂暂停徽标（⏸ + 待放行/已放行/已调整/已停止）。**否决独立 `CheckpointNode`**（step 与下游之间插入合成节点 + ELK 重布局）——视觉更突出但代价显著，徽标已满足「图上可见检查点」；独立节点留作后续 richer 形态。→ 见代码 `stores/execution/`（`RunCheckpoint`）、`components/graph/AgentNode.tsx`。

> 多轮辩论用普通 agent 节点（主持人 + 辩手，✅ 见 §四），无独立 arena 节点。**已否决·工具点节点**：每个工具调用单独成图节点 = 与「inline 只做信号、面板承担完整详情」+ §八 ≤50 节点性能约束冲突（一个调研 agent 调 10 次 `web_search` 即 +10 节点）；工具已被 agent 节点「工具数」+ `SidePanel` run 详情工具 IO 区段覆盖，无需独立节点。

> **运行机制（产品手册）**：`工具箱 → 产品手册 → 运行机制`（`/toolbox/manual`）。面向用户的协作透明页，用真实图组件标注机制含义；纯用户向，**否决**页内开发者细节开关。→ 见代码 `components/manual/MechanismContent.tsx`、`pages/toolbox/manual/`（`ManualShell.tsx` 全屏壳 + `/toolbox/manual/mechanism` 子路由）。

---

## 六、聊天 ⇄ 画布双视图 ✅ 已落地

多 Agent 协作图从「聊天消息里内嵌的一个组件」（`InlineTeamGraph`，§三）升级为可与聊天**平起平坐的第二视图**——一块「画布」。已**毕业**（原实验开关 `canvasEnabled` 已撤）：入口恒显示、无需开启；**对话页恒为传统聊天**（早期把对话页也卡片化的第一刀已撤，见 §6.4），画布是按对话 opt-in 的第二视图。

**核心论点 · 一份数据两种渲染**：后端单 Agent = 只有 Captain 的退化 Team、单 / Team 同一执行路径（[`Agent协作模式.md §设计哲学`](/docs/03-AI核心/Agent协作模式.md)）这条洞察只用在**数据层**——同一份「回合 + 执行（CEO+worker DAG / journal）」既可渲染成聊天、又可渲染成画布。两视图同源 `projectExecution` fold，**切换 = 换视图不换数据，不动协议 / `turn_journal` / conformance**。

| 视图 | 渲染 | 默认 |
|---|---|---|
| 聊天模式 | 回合 → 气泡 + 内联协作图（团队回合就地开花，§三） | ✅ 默认 |
| 画布模式 | 同一批回合 → 单张持久空间画布 | opt-in |

**默认聊天 + 显眼入口**：差异化靠「团队在该出现处就地开花 + 一步进画布」，不靠强迫所有人上画布——聊天里一起团队即内联出图（`InlineTeamGraph`），其上「在画布打开」主按钮一键切到画布；顶部 `聊天 / 画布` 分段切换按对话记忆视图模式（`conversationViews`，**持久化** `localStorage: agentcore:conversation-views`、只落画布 override 切回即删键）。

### 6.1 画布 = 单张持久画布（视觉累积，非 worker 实体化）

一个对话 = 一张可平移画布，每回合自上而下**跨回合视觉累积**成节点；「同一拨人」靠 `agentIdentity`（同角色稳定色 / 字，§五）延续，**团队仍每回合临时组、不做 worker 实体化**（真持久团队见 §6.4 否决）。

**LOD「只有聚焦回合画完整 DAG」**（守 §八 ≤50 节点 / ≥60fps）：完成的团队回合塌成「回合摘要节点」（状态 / 任务摘要 / 身份头像 / 进度）、单 Agent 回合塌成竖排轻卡，**恰好一个聚焦回合**（默认最新、自动跟随新回合、点摘要可切换）就地展开完整 worker DAG；配小地图 / 相机。聚焦回合内嵌整套 `GraphView`（点 worker 走右坞 run 详情、点端点〔汇聚点读最终回答 / 用户端点重读提问〕开右坞「内容 tab」）+ 就地脚抽屉（仅承表头 chip 唤出的「版本对比」比对；辩论回合无 peek、全程走放大态「辩论室」），深读 / 放大走**画布放大态**（Route A · `CanvasZoomedTurn`，就地放大该回合、非独立 overlay；旧 `TeamGraphFullscreen` 全屏 overlay 已被其替代）。命令栏 `CanvasCommandBar` 常驻画布底栏（与放大态共用），且与聊天输入框**统一为同一 composer 核**（`TurnComposer`，2026-07）：附件 / @ 文件引用 / 停止生成 / 字数 / 回填通道两视图同款，草稿按对话存 store、聊天 ⇄ 画布切换不丢，正文并持久化 localStorage（重启不丢；附件仅会话内，防配额且盘上易过期）（`MessageInput` / `CanvasCommandBar` 只是两层皮）。**对话页（聊天视图）恒为传统聊天**——不再把单 Agent 回合渲染成节点卡，图相关体验收敛在画布（原「对话页卡片化」第一刀已撤，见 §6.4）。

### 6.2 图上指挥：指挥台 `CommandRegion`（统一侧面板顶部常驻区）

画布一旦成为管团队的地方，检查点 / 发问 / 审批 / 续跑 / 救火这些**老板权力**必须能就地行使（一个「掌管团队」的视图不可能只读）。落地**不**逐个塞进节点，而是把指挥台收口为**统一侧面板（§十）顶部的可折叠常驻区** `CommandRegion`（面板标题「指挥台」，徽标计待裁决数；不再单开第二个右坞，取舍见 §6.3）：

- **双作用域同处一面**：回合级（`ask_user` 检查点 / `plan_review` / 工作者上报 / **救火行**）随**聚焦回合**的 message + 投影执行渲染；对话级（工具放行 approval / 待恢复续跑 resume / **传输错误重试 `RetryBanner`** / **后台云端任务 `BackgroundTaskCard`**）自带 store + 当前对话自渲染。画布模式下 `ChatView` / `InlineTeamGraph` / `MessageList` 未挂载，其对话级卡片、救火行与时间线内的后台任务卡本会**消失且无法操作**——故必须在统一侧面板的指挥台区（`CommandRegion`）承载。
- **救火**（失败重试）：聚焦回合终态有失败（整轮崩 / 部分失败 / 已停止）时，指挥台渲染聊天同款 `RecoveryActions`（**重试整轮 / 调整指令 / 忽略**——重试走 `runRegenerate` 从最后一条用户消息整轮重跑、忽略清本回合执行槽，与聊天一致）；外加对话级 `RetryBanner`（发送 / 续跑 / 重生成断流的传输错误重试）。聚焦节点头另挂一枚「待救火」红牌。
- **后台云端任务**（非阻塞 · 跨对话的「另一类」）：本地模式对话的云端交接任务（`BackgroundTaskCard`，§十）原按时间戳并入聊天时间线；画布无时间线，故收进指挥台**末尾**（卡片自带派发 / 运行 / 失败状态 + 完成后「查看并应用」内联评审）。**不计入「待你拍板」**（非决策、不污染节点徽标），但其存在 / 新到一项会自动浮出指挥台；轮询同步由常驻的 `ConversationCanvas` 驱动（指挥台收起时仍刷新，故计数能反过来浮出面板）。发起侧：画布命令栏 `CanvasCommandBar` 也带「后台云端」开关（仅本地模式对话亮出），可在画布里直接派发，走与聊天**同一** `dispatchBackgroundTask` 通路、结果即落本指挥台。
- **逐字复用聊天同款卡片**（`CheckpointCard` / `PlanReviewCard` / `EscalationCard` / `ApprovalPrompt` / `ResumePrompt` / `RetryBanner` / `RecoveryActions` / `BackgroundTaskCard`，§三），操作经**同一**服务 + SSE 折叠（守单一数据源、不开第二条通路）；`interactive` 取聚焦回合 `isStreaming`，重载 / 已结束回合的卡片呈被动记录。
- **数据来源（画布→面板桥）**：转 focus 是画布概念，故 `ConversationCanvas` 经 `stores/commandPanel.ts` 只发布「画布已挂载 `active`」+「聚焦团队回合 id」；区自己从执行 / approval / resume / 后台任务各 store **现取**派生（单一数据源、不拷快照）、自管自动浮出。`active` 是画布专属门——聊天模式恒 false 故区不出现（聊天的决策本就内联在消息流）。
- **自动浮出 + 折叠（非关闭）**：聚焦节点头部「待你拍板 N」/「待救火」提示牌指向指挥台；有待裁决项（回合级计数 + 对话级 approval + resume）、可救火（聚焦回合失败 / 对话传输错误）或有后台云端任务时，**每来一个全新待办都自动展开本区并揭示侧面板**（`openPanel` 只开 dock、**不切**你当前 tab，故正看的 run 详情不被挤走），焦点切换 / 新项到达再武装（重展开）；用户可经表头 chevron **折叠**成一条（仍亮角标），但**关整个面板**走侧面板自身的 X / `Ctrl/Cmd+I`——折叠 ≠ 关 dock。区高**封顶约 55%** 面板内容高 + 区内滚动，故下方 tab 体（run 详情 / 工作区）恒留可用高度。

### 6.3 关键决策（代码看不出的取舍）

- **双视图而非「图即唯一界面」**：原方向「无模式切换、聊天 = 图的退化渲染、最终砍掉聊天列」**已撤**——强迫简单问答上画布是负体验，且整方案命悬「画布必须像聊天一样轻」的试金石。双视图（聊天默认 + 画布 opt-in）零门槛天然、风险降到「加一个视图 + 一个开关」、**聊天永不删**；「聊天 = 图的退化渲染」只保留在数据层。
- **画布已毕业（撤实验开关）**：原 `canvasEnabled` 实验门为开发期守「画布像聊天一样轻」试金石而设；试金石已过（聊天默认零回归 + 画布 opt-in 顺滑），故撤门——入口恒显示、无需开启，免「藏命令面板后没人发现 + 永远 dogfood 不到」。每对话视图偏好随之由会话内存态**升为持久化**（`localStorage: agentcore:conversation-views`，只落画布 override、切回即删键 → 表恒收敛），刷新 / 重开对话记得上次停在画布还是聊天。
- **内嵌 DAG = 嵌套 ReactFlow**：聚焦回合把整套 `GraphView` 包进外层画布的自定义节点，靠**独立 `ReactFlowProvider` 隔离 flow store**；内层 `embedded` 弃自身平移 / 缩放、外层画布独占平移 / 缩放 / 小地图。→ 复用既有图构建，不重写第二套图。
- **聚焦节点固定高度**（`FOCUS_NODE_HEIGHT`）：脚抽屉（仅「版本对比」；读答案 / 重读提问已改走右坞「内容 tab」，辩论回合走放大态「辩论室」无 peek）与内嵌图**共享这块固定高度**（开抽屉图区缩、抽屉占下半承版本列 `DRAWER_H`、图区相应再缩），节点总高恒定 → 下方回合堆叠偏移不被挤动。**否决**抽屉撑高节点（触发动态高度 → 重算堆叠）。
- **面板停靠 ≠ 节点弹层**：可裁决 / 救火卡片体量大（表单 / 备注 / 多按钮），浮节点上会挤爆 LOD 视图；故收口到**统一侧面板顶部的指挥台区**、聚焦节点只留「待你拍板 / 待救火」提示牌指过去。
- **指挥台并入侧面板顶部区，而非第二右坞 / 并列 tab**：并排双右坞吃 ~760px + 双边框双开关；做成侧面板里的**并列 tab** 又有三患——切 tab 互斥故看不到「指挥台 + run 详情」同屏、自动浮出会抢走你正看的 tab、还得给「指挥台 tab 钉到哪个回合」一个别扭答案。**顶部常驻区**（封顶 + 折叠）让两块同屏可见、自动浮出不抢 tab、两套定位逻辑（区跟随聚焦回合 / tab 按 message 钉）互不干扰。

### 6.4 守住的决策 / 被否决 / 暂不做

**守住**（不因双视图推翻）：CEO 智能路由**不给选择器**（画布只让你在 CEO 组好的团队上行使老板权力，指挥 ≠ 替 CEO 组队，§十一）；节点 ≤50 / ≥60fps 靠 LOD（§八）；节点 face 极简（数字归 run 详情）；简单任务零噪音（聊天默认 + 画布退化竖排双重守住，§三）。

| 方向 | 处置 | 理由 |
|---|---|---|
| 图即唯一界面 / 无模式切换 | 撤 | 见 §6.3 |
| 对话页卡片化（单 Agent → CEO 节点卡 / 团队图聊天内就地读，原画布实验第一刀） | 撤 | 把传统对话页改成卡片是早期理解偏差；图相关体验收敛到「画布」opt-in，对话页恒为传统聊天（删 `CeoNodeCard` + `AssistantMessage.isSoloGraph` + `InlineTeamGraph` 聊天就地读） |
| 丙 · 自适应默认（按有无团队自动切模式） | 否决 | 中途翻模式 = 错愕；「何时切」判据含糊 + 每对话模式偏好状态边界多；收益小（简单回合本就退化轻卡）。改用「显眼内联入口」达成同等「画布在相关时出现」 |
| 乙-2 · 真持久团队（worker 实体化） | 暂不做 | 「团队跨回合」真需求 = 连续性 / 团队懂我，已由记忆模块 + CEO 跨回合记忆 + 共享工作区覆盖；worker 实体化撞「无选择器 / 每回合自适应组队」赌注（[`执行引擎架构设计.md` §受监督的波循环](/docs/03-AI核心/执行引擎架构设计.md)），是定位级（养成系）改动 |
| 跨对话 / 工作区 / 公司级空间画布 | 不在范围 | 本特性只管单对话内双视图（原『公司画布』上层提案已删除） |

**✅ 收口**：图上指挥与比对卡片已全数上画布——`BackgroundTaskCard`（云端 / 后台任务卡片，非阻塞 · 跨对话的另一类）入指挥台（见 §6.2）；「版本对比」**已彻底移出聊天正文**（2026-07，与辩论「过程归画布、正文只留信号」对齐）（`compare/TurnCompare`，2026-07，§6.5）：正文不再内联版本对比大卡，改由状态条**「改了 N 版」信号 chip** 深链画布；画布两处落点——**放大态「对比」视图**（`CanvasZoomedTurn` 视图切换器，§6.5）承载完整对比（**仅非辩论定向唤回修订**：胶片轨 + 聚焦精读 + 按需 2-up + 相似修订自动文本 diff；辩论的两方对照由辩论室可选左右并排布局承担、见 §4.1），**概览聚焦节点脚抽屉**（表头 chip 唤出·仅非辩论修订）作就地 peek，二者共用同一 `TurnCompare`、逐版本仍下钻右坞 run 详情。至此聊天正文只留信号（辩论 pill /「改了 N 版」chip）+ 入口 CTA，过程产物全归画布（**定向唤回**「修订 vN」本身仍 CEO 驱动、无用户触发入口，其结果另作 `AgentNode` 节点画在聚焦回合 DAG 上）。

→ 见代码：`stores/ui.ts`（`conversationViews` 持久化、只落画布 override；`pendingCanvasFocus` 携可选深链 `view`＝`CanvasFocusView`）、`pages/ConversationPage.tsx`（视图切换 + 偏好读取）、`chat/StatusStrip.tsx`（团队回合入口：辩论「打开辩论室」CTA / 普通「在画布打开」+「改了 N 版」版本对比信号 chip）、`graph/ConversationCanvas.tsx`（持久累积 + LOD + 发布画布 active/聚焦回合 + 后台任务同步驱动）、`stores/commandPanel.ts`（画布→指挥台区桥：active/聚焦 + 折叠态）、`graph/CanvasDecisionPanel.tsx`（`useCommandRegion` 派生 + 自动浮出 + `CommandRegion` 折叠区，复用 §三 同款决策卡片）、`layout/SidePanel.tsx`（顶部承载指挥台区，§十）、`graph/TurnSummaryNode.tsx` / `graph/SimpleTurnNode.tsx` / `graph/FocusedTurnNode.tsx`（内嵌 `GraphView` + 端点开右坞内容 tab + 版本对比脚抽屉〔辩论走放大态辩论室〕 + 提示牌）、`graph/CanvasCommandBar.tsx`（常驻命令栏 + 后台云端派发）、`chat/compare/`（`TurnCompare` 壳 + `RevisionOverview` 胶片轨/聚焦精读 + `ComparePane` 回合级「跨方任意两段」对比 + 相似修订自动 `@codemirror/merge` diff + `cells.ts` 统一 pick 单元；嵌放大态「对比」视图 / 概览脚抽屉；聊天正文已不再内联）、`lib/agentIdentity.ts`（身份延续）。

### 6.5 放大态视图：群聊 / 协作图 / 对比 + 协作图「时间轴」布局 ✅ 已落地

放大态（`CanvasZoomedTurn`）顶栏给一个**视图切换器**（≥2 个可用视图才出现），同一回合在多种渲染间切换，**按回合性质分叉**：

- **辩论回合**：只有 **辩论室**（赛事页 `DebateArena`，§4.1）作内容主视图；**两方对照＝辩论室内可选「左右并排」布局**（仅正反 2 方 · 记分牌「布局」开关、默认并排可切单栏、逐轮发言分栏，§4.1）、**协作图＝头部按钮唤出的浮层**（`graphOverlay`；浮层内为与非辩论相同的 `GraphView` + 布局 toolbar，§下「时间轴布局」），均不再是平级 tab，故辩论回合放大态基本无 tab 条。
- **非辩论回合**：**协作图**（依赖结构，默认）/ **对比**（统一对比透镜 `compare/TurnCompare`，**仅定向唤回修订** → 版本轨〔`RevisionOverview`，胶片轨 + 聚焦精读，下文〕；点任意两格进共享精读对比面〔`ComparePane`，2-up / 真·文本 diff〕；仅当本回合有修订链，§6.4——聊天正文已不再内联，改由状态条「改了 N 版」信号 chip **深链**首挂直达）。**不再有「并行时间线」平级 tab**——时间真相改由协作图 toolbar 切换（下）。

默认：辩论落群聊、非辩论落协作图（**左右流**依赖布局）、聊天「回放」深链落协作图并自动帧回放；**对比恒为可选透镜、从不作默认**（可经信号 chip 深链首挂直达）；**时间轴布局恒为可选、从不作默认**（`hasParallelTimeline` 门控后才可点）。

**协作图三种布局（用户偏好持久化 `stores/graph.ts`）**：放大态与非嵌入 `GraphView` 右上角 toolbar 切换——① **左右流**（默认，ELK 横向依赖 DAG）② **树形**（ELK 纵向）③ **时间轴**（`timeline`，仅 `hasParallelTimeline` 为真时可点；调度段跑完、`batch_metrics` 折到前端后才有完整坐标，执行中按钮 disabled）。时间轴模式下：**同一套 worker 节点与 drill-in**，X＝`NodeTiming` 墙钟偏移、Y＝每 run 一行、节点条宽∝占用时长；输入 / CEO 汇聚点钉在 worker 带左右；多调度段画竖向「批次 N」分隔（`TimeBatchMarkers`）。依赖布局背景的 `WaveLanes` 文案为 **「依赖层」**（ELK 深度，≠ 调度时间）；时间轴模式下隐藏泳道。**帧回放**（左下 HUD `CanvasPlaybackControls`）仅在左右流 / 树形下可用——时间轴展示的是终态调度结果，与逐步帧投影语义不一致故互斥。Toolbar 旁仍可挂 **`metricsSummary` chip**（峰值并发 · 总时长 · 串行化次数）。内嵌聊天列 `GraphView`（`embedded`）不展示布局 toolbar，且强制依赖布局（不用时间轴）。

**版本对比版式 · 胶片轨 + 聚焦精读（多轮不崩）**：一条版本链可累积很多版本（定向唤回修订：一个 worker 被 CEO 多次续写），故 `hasRevisions` 为真——此版本轨 `RevisionOverview` 现**仅承载非辩论的定向唤回修订**（辩论回合含多轮辩论虽也被建模成「续写 revision」〔`revision N == 第 N 轮`，`stores/execution/debate.ts`〕，但其两方对照由辩论室可选左右并排布局承担、不进对比 tab，见 §4.1）。等分并排到多轮必崩（每列挤成几个字、还各自纵滚）。故每条链渲染为**版本轨**（`v1…vN` 缩略卡：状态点 + `原始/最新` + 字数 + 两行预览，多轮只让轨**横向滚动**、绝不挤压阅读区）+ 下方**聚焦 / 对比区**：默认 **2 版直接进「对比」**（经典并排）、**3+ 版聚焦最新版全宽精读**；**回合级「对比两版」开关**：开启后所有链只留轨，版本卡可**跨链勾选任意两版**（`A`/`B` 徽标带角色名，**可跨方/跨角色**——支持方 v3 × 反对方 v3、撰写员终稿 × 审阅员意见…），默认 **≥2 方＝两方各自最新互比、单链＝原始×最新**；下方**共享对比面板** 2-up 并排、两版全宽可读（不对比时保留每条链的轨+聚焦精读）。**真文本 diff（自动开）**：两段读起来像同一交付物的「编辑」时（`looksLikeEdit`：共同首尾够长 + 长度相当）自动开 `@codemirror/merge` **侧栏 diff**（未改处折叠、增删分色、跟随亮 / 暗），可一键切「渲染」；**跨角色内容本就不像编辑 → `looksLikeEdit` 判否、走 2-up**（不按内容类型一刀切——某链 v3 × v5 若确是延写微调也给 diff）。同一角色跨版本、跨方 / 跨角色**任意两段**都能比，共用此精读对比面 `ComparePane`。承载页 `CanvasZoomedTurn` 统一「对比」页用 `max-w-5xl`（比阅读列宽，给 2-up / diff 更多地方）。

**为何要时间轴布局（多任务并行图）**：协作图画的是**依赖结构**不是**时间真相**——`WaveLanes` / `computeWaves` 按 ELK 布局深度分**依赖层**，同一层两节点可能被 `width` 上限错峰跑却被并排画；`RunNode` 只有 `durationMs`、无起止戳，前端拼不出「谁和谁真同时在跑」。时间轴布局把每个 worker run 按**相对调度器 wall start 的 ms 偏移**铺在横轴上，于是肉眼可见：**重叠＝真并发、条前空档＝并发上限 `width` 让就绪节点排队（串行化）、最长条＝关键路径**。

**数据来源 = 搭 `batch_metrics` 顺风车，零新增事件**：`WaveScheduler` 每节点的 dispatch/finish 时刻本就用来累加 `busy_ms`——把它**留下不丢**即得每节点占用窗口（`BatchMetrics.timeline` → `NodeTiming`），随既有 `batch_metrics` SSE/journal 折到前端 `execution.batches[].timeline`。只派发过的节点有窗口（级联跳过的从未跑、不占条，其计数仍走 `skipped`）；多调度段（checkpoint/scope 让渡续跑）在 time layout 里按 `wallMs` 拼接为连续轴，并标「批次 N」分隔。

**落点 · 面向全员（非诊断门控）**：时间可视化是**过程透镜**、对所有人有价值，故落在协作图 toolbar、**不藏在 `diagnosticMode` 之后**——区别于**同一份 `batch_metrics`** 的**聚合指标**（平均并发 / 槽位等待 / 自我纠偏边界）只在诊断模式的 run 详情「调度」块出现（§十）。一份数据两个投影：聚合走诊断、时间轴走布局切换。门控 `hasParallelTimeline`（≥2 个派发节点）才启用第三项——单 worker 一条 bar 无可看。**被否决**：协作图底栏常驻甘特（占画布高度、与 toolbar 摘要重复）及「并行时间线」独立 tab / 浮层子视图（与协作图节点重复、切换成本高）。**桌面专属**：移动端 fold no-op `batch_metrics`、不进 conformance `ProjectedTurn`。

> 注意：本节是**单回合内 worker 并行**的时间线，与 §十五「多任务同时进行」（多个任务 / 会话**跨回合**并行的总览面板）是两件事，后者仍 ⏳。

→ 见代码：`lib/time-layout.ts`（时间轴坐标）+ `components/graph/GraphView.tsx`（布局 toolbar · 删底栏甘特）+ `components/graph/GraphToolbar.tsx` + `components/chat/ParallelTimeline.tsx`（`hasParallelTimeline` / `parallelTimelineMetricsSummary`；`ParallelGantt` 保留作组件与单测，主路径不再挂底栏）+ `components/graph/CanvasZoomedTurn.tsx`（放大态多视图）+ `runtime/runs/wave.py`（`timeline` 埋点）+ `stores/execution/frames.ts`（`batch_metrics` fold）。

---

## 八、图视图技术选型

**被否决**：
- **D3**——与 React DOM 模型冲突；节点内容复杂（进度条/多行/状态灯）SVG 手绘极痛苦；丢失 React 组件复用与状态管理。
- **自研画布**——图视图非核心壁垒（编排器才是），自研需 1–2 个月，资源错配；50 节点不需要 Canvas/WebGL 极限性能。

**性能约束**：节点 ≤50、≥60fps、首屏 <200ms、布局计算 <100ms。

---

## 九、文件交互设计 ✅ 已确定

> **文件夹即工作区**：两个入口——① 对话内工作区面板（SidePanel）；② 文件中枢 `/files`（VSCode 式左树右详情，跨项目全局，承载文件夹生命周期）。`/conversations` 仅按文件夹筛选，文件夹增删改归 `/files`。技术细节 → 见 [`前端技术与架构.md` §8](/docs/04-前端/前端技术与架构.md)；后端契约见 [`双模式工作区.md` §九](/docs/02-架构/双模式工作区.md)。

**设计原则**：一棵以本地授权目录为根的树。**被否决**：「云端/本地两平级源」上下分段——心智割裂 + 主次写死。

| 交互 | 行为 |
|------|------|
| 添加文件夹 | 选本地目录 = 立即成为一个项目（建云端身份一步到位） |
| 展开目录 | 懒读子项 + 启动 watch；折叠即停止 watch |
| 内联改名 | 就地 input，回车/blur 提交，Esc 取消 |
| 拖拽移动 | 落点校验（非原父/非自身子树） |
| 右键菜单 | 普通节点：新建/下载/打开/重命名/删除（共用 `FileTree`）；**工作区根节点**（文件中枢 `FileWorkbench`）：重命名/删除/新建文件·文件夹/上传/查看对话（跳 `/conversations` 筛该项目）；根级「设为项目」已隐含（加文件夹即建项目），「连接/断开」本地目录 ⏳（待文件夹级绑定端点） |

**工作区删除 vs 对话整理（✅ 已确定 · 对标 ChatGPT/Codex 分层）**：**对话层**——归档（可恢复，隐藏活跃列表）/ 永久删除（用户视角不可恢复），见 §一；**工作区（Folder）层**——**不做「归档项目」**（行业亦无独立概念），侧栏降噪靠**组头「归档全部对话」**（批量归档该项目下活跃对话）或在 `/conversations` 按文件夹批量归档。**删除项目**（`/files` 工作区根右键 + 侧栏组头「删除项目…」· 现有 `folders` soft-delete，共用 `DeleteProjectDialog`）：仅删容器——其下对话**固定归档**、**不**删对话记录；项目文件归 Folder 所有，保留至保留期（默认 30 天，见 [`双模式工作区.md` §七](/docs/02-架构/双模式工作区.md)）后 sweeper 物理清理。**否决** ChatGPT 式「删 Project 级联删全部聊天+文件」——真实工作区（本地盘 + OSS）下对话是索引、文件是资产，级联过狠。**否决** `Folder.archived` 第三整理层。**删除确认**（✅ 已落地）：主对话框两行说明（对话归档 + 文件约 30 天清理）+「取消 / 删除项目」；底部链「需要立即清除全部数据？」进入第二步二次确认（无输入项目名）。软删路径固定归档其下对话。**「彻底删除项目」**（✅ 核按钮、第二步）：一次性清对话+文件+快照（`DELETE /v1/folders/{id}/permanent`）；本地项目不删用户磁盘文件。→ 见代码 `components/folders/DeleteProjectDialog.tsx`、`agentcore/folders/permanent_delete.py`。

**审批 UX（写操作）**：只读时尝试写引导开启；可写时写前弹审批（可「本轮内都允许」按同名工具、或「本轮内允许所有文件改动」按整类一次放行，依赖 §三工具审批三态 `grantable` 级别，避免 N 次写/改/删 = N 次弹窗）。

**对话落点表达（✅ 草稿期工作区选择器 · B3+）**：新对话草稿输入框工具行挂 `DraftWorkspacePicker`。**默认不选**时不挂 chip，仅轻量「归入项目…」；不选 ≡ 桌面 local-first 懒建（零门槛不变）。显式选「仅云端」或某项目后显示确认 chip（云端 / 项目名 + 清除；清项目保留存储、清云端回到本地默认）。面板分两区：**存储位置**（桌面：本地默认 / 仅云端随手聊；web 默认云端故不展示存储区）与 **归入项目（可选）**（搜索 + 最近 3 条，只选已有项目、不在此创建）。**新建项目** canonical 入口 = 命令面板「新建项目」（`CreateProjectDialog`）；草稿期若正在新对话，创建后自动归入该项目。**B4**：草稿期 `@` / 浏览附加来自某项目的文件时，内联提示是否归入该项目（`DraftWorkspaceAssignPrompt`）。落点经 `pendingNewChat*` 传给首发建会话；侧栏工作区组头另提供「新建对话」预填落点。首发后锁定，改由 `WorkspaceModeBar` 承担。→ 见代码 `components/chat/DraftWorkspacePicker.tsx`、`components/folders/CreateProjectDialog.tsx`、`components/chat/DraftWorkspaceAssignPrompt.tsx`、`components/sidebar/WorkspaceGroupHeader.tsx`。

**隐私承诺**：默认不留存（未备份内容不进云）；在途可用（读文件时正文临时发给模型）；备份/分享 = 显式上传（不自动同步，操作前明示）。

**AI 产物可编辑**：工作区面板 `.md/.markdown` 可编辑（CodeMirror + 编辑/预览切换、CAS 写盘、选区 AI 改写）。→ 见 [`前端技术与架构.md` §八](/docs/04-前端/前端技术与架构.md)（`lib/fileSource.ts`、Markdown 编辑）。

**回合内文件呈现（✅ 已落地）**：① **文件产物内联卡**——回合若写了文件，答复正文下方挂一张 `FileArtifactsCard` 列出本回合产物，点行经 `useSidePanelStore` 在工作区面板预览（单 Agent 取 `process`、多 Agent 取 execution 投影，去重合并）；② **工作区升级提示**——裸聊首次写文件触发 `workspace_promoted`（升为文件夹工作区）时，给当前助手气泡内联一条「已升级为工作区『X』」轻提示，解释文件夹为何突然出现。**live-only 不持久化**：重载后文件夹本就在、不再是「新闻」。→ 见代码 `components/chat/FileArtifactsCard.tsx`、`components/chat/message-bubble/AssistantMessage.tsx`、`services/sse/handlers/workspace.ts`。

---

## 十、详情面板与委派展示 ✅ 已确定

> **实现现状**：对话右侧收敛为**单一侧面板** `SidePanel`，建模为**一条扁平 tab 栏**（外壳：拖拽 resize + tab 栏 + 关闭）——
>
> - **固定首位「工作区」home tab**（永不关闭，**文件即主体**）：头栏模式 pill（点开 popover 承载云/本地切换·绑定/重连/备份到云）+ 🕘 快照（右侧 slide-over）图标浮层；文件树即面板主体（交接已下沉为对话时间线卡片、不占面板入口，见下）。
> - **按需详情 tab**：点内嵌协作图 worker 节点把该 run 钉为 run 详情 tab；点端点（用户输入 / CEO 汇聚点）在画布钉为「内容 tab」读提问 / 最终回答（是气泡非 run）。可并存对比、上限 6（进度/协作图归内嵌图，面板不设独立 tab）。
> - **顶部常驻钉区（画布模式）**：tab 栏下、tab 体上可有可折叠的常驻区——**指挥台** `CommandRegion`（有待裁决 / 救火 / 后台云端任务时，§6.2）。~~辩论裁判台 `DebateHudRegion`~~ **已移除**（2026-07-06，记分/掌舵归赛事页主列，§4.1）——各自封顶 + 区内滚动、保 tab 体可用；聊天模式不出现（决策内联在消息流、辩论只在放大态）。
> - **单一面板取代并排双右坞**（并排会挤爆聊天）：工作区即常驻首 tab、run 与它同栏并列，故面板永不出现空详情占位（**否决**「详情 / 工作区」段控互斥）；画布指挥台亦并入本面板**顶部常驻区**、不再另开右坞（§6.2）。工作区 body 首次激活懒挂载、之后 keep-alive 不卸载（文件不重拉）。
> - **状态**：共享一份 `open` / `width`（280–560px，均持久化；快照为面板本地瞬态）；run tab 集为会话级、按 `messageId` 投影对应回合执行槽。
> - **节点高亮一面一源**：派生自当前激活 tab——激活某 run tab→高亮其节点，激活「工作区」tab（不在 run tab 集）→无高亮；关 run tab 回退相邻 run tab、否则落回「工作区」tab（面板不因此关闭）。
> - **打开入口**：点图节点→新开 run tab；右上「侧面板」开关（`PanelRight`，常驻、开启高亮）/ `Ctrl/Cmd+I`→显隐（记忆激活 tab、**冷启动落「工作区」tab**）；`Ctrl/Cmd+J`→直达「工作区」tab；`Ctrl/Cmd+B` 留给左侧栏折叠避免双触发。
>
> （→ 见代码 `stores/sidePanel.ts`（含 `openPanel` 不切 tab 揭示）、`components/layout/SidePanel.tsx`（顶部指挥台钉区 + 下方 tab 体）、`stores/commandPanel.ts`（画布→指挥台区桥）、`components/graph/CanvasDecisionPanel.tsx`（`CommandRegion`，§6.2）、`components/chat/detail/RunDetailBody.tsx`、`components/workspace/WorkspacePanel.tsx`（`WorkspaceMode`）、[`前端技术与架构.md` §9.2 / §9.4](/docs/04-前端/前端技术与架构.md)）本节为关键决策。

> **交接 = 时间线卡片（交接「方案 B」）✅ 已落地**：「把活交给云端团队」不再是工作区面板里的居中宽模态，而是对话时间线里的「后台云端任务」卡。本地模式对话在 `MessageInput`（及画布命令栏 `CanvasCommandBar`）的「后台云端」开关下派发任务（`dispatchHandoffJob`），随即落一张卡（派发中 / 运行中 / 已完成 / 失败，按时间戳并入时间线、随对话重开重放）；完成后卡内「查看并应用」就地展开**内联简化评审**——默认全部接受（干净变更直接应用），只把真冲突逐个列出选「云端覆盖 / 保留本地」、可展开预览，应用回本地（写回前重读本地哈希、服务端按快照哈希权威复核冲突）。三段式后端契约（snapshot / 云作业 / diff 三方判定回写，`HandoffJob` 专表）不变，仅前端入口从侧栏孤岛下沉进对话。→ 见代码 `components/chat/BackgroundTaskCard.tsx`、`components/chat/BackgroundTaskReview.tsx`、`stores/backgroundTasks.ts`、`components/chat/MessageInput.tsx`、`components/graph/CanvasCommandBar.tsx`（画布同款开关）、`components/graph/CanvasDecisionPanel.tsx`（`CommandRegion` 承载卡片）。

聊天右侧详情面板 = Agent 执行的「点开看详情」查看器：正文气泡保持简报（思考折叠条 + 内嵌协作图信号），点图节点后右侧推入该 run 完整详情。**核心价值**：Multi-Agent 一次交互信息量大，正文保持简报、细节按需点开。

**关键行为决策**：

| 决策 | 取值 | 理由 |
|---|---|---|
| Tab 管理 | 动态打开/关闭（非固定 Tab 栏） | 用户只看关心的 |
| 标签上限 | 6，超出淘汰最旧 | 防无限堆积 |
| 持久化 | `open` + `width`；run tab 集会话级（`section` 已删：文件常驻，快照为瞬态） | 面板形态持久，run tab 是临时工作态 |
| 多开 | 多个 `run-detail` 可并存对比 | **否决**每次覆盖 |
| 数据获取 | Tab 只存引用（指针），详情从 run 树现取 | 单一数据源 |
| 下钻导航 | 子任务点击开新 Tab，无限层级 | 各 Tab 独立 |
| 打开方式 | 点内嵌图节点下钻该 run（无自动进度 tab） | 按需、零噪音 |
| 节点高亮 | 内嵌图与放大态**同源派生自**面板当前激活详情 tab（run tab 亮 worker、内容 tab 亮端点；切/关 tab、切到「工作区」tab、关面板自动跟随）——放大态点节点把 run 详情 / 端点内容开到右坞 `SidePanel`（复用同一 `sidePanel` store） | 一面一个高亮源，**否决**反向 `selectRun` 跨 store 对账 |

**run-detail 区段构成**（顺序即 `RunDetailBody.tsx` 渲染序，条件区段无数据时不渲染）：头部（角色 / 状态 / 用时）、任务、**改版链**（同一 worker 多次修订的版本链 +「对比」入画布）、**升级**（`run.escalations`：worker 中途求决策 / 汇报）、**收到的上下文**（该 run 实际被喂进的结构化上下文：原始请求 / 团队位置 / 前置结果〔含来源·保真度·是否截断〕/ 工作区 / 任务…，由 `run_context` 事件折入；守「单一源：用户看到的 == LLM 吃到的」，每块一张可展开卡片，默认折叠；详见 [`../03-AI核心/上下文传递可视化.md`](/docs/03-AI核心/上下文传递可视化.md)）、**思考过程**（worker 思考全文，`run_reasoning_delta` 流式；流式时自动展开、完成自动收起）、**错误**（失败强制展开）、**正在生成**（worker 拼装工具调用参数时的实时行「{工具} · N 字」，`run_tool_progress`；仅运行中且参数流式中出现，参数拼完即让位给下方工具调用行）、**工具调用**、**输出**、**结论 / debrief**（`run.debrief` 或 `outputSummary`）、**关系**（单节合并：`dependsOn` 依赖 / 后续 + 上级 captain / 子任务树——横向 DAG 依赖与纵向委派层级并列于同一区段；多 Agent 回合另有 **「数据从哪来」** 子块（默认折叠）：`GET …/audit?include_causal=true` 拉回合因果图，仅渲染当前 run 的 **inject 入边** 列表，上游行可下钻；保真度/截断不重复——见上方「收到的上下文」；无 inject 入边则不显示子块）、**资源消耗**（全量 token + ¥ 明细 + 模型档位·思考强度；**恒默认展开**，见 [成本呈现 §7.1](/docs/04-前端/前端成本呈现.md)；¥ 合计常驻区段头部。档位·思考强度原为独立「模型与推理」区段，因属低频信息已并入此处）、**诊断信息**（仅 `diagnosticMode` 开启时出现、默认折叠：run / agent / 执行 / trace id 及类型·依赖·模型等底层标识，便于把该 run 对回服务端日志；纯展示，气泡另挂 trace id 一键复制）、**审计**（`AuditSection`，有 conversationId 时）。**独立 `reasoning` Tab 已否决**——思考全文本质 per-run，归 run-detail「思考过程」区段而非全局 Tab。→ 见代码 `RunDetailBody.tsx`。

**诊断 / 开发者模式（✅ 已落地 · 骨架）**：独立用户开关 `diagnosticMode`（默认关，持久化 `localStorage: agentcore:diagnostic-mode`），诊断是开发者「底层信息」专用开关，**与「用量 / 成本」呈现无关**（用量明细已恒展示、无粒度开关，见 [成本呈现 §7.1](/docs/04-前端/前端成本呈现.md)）；单独一开关，免得开发者噪音污染大众面。入口：「关于」页开关 + 命令面板「开发者 / 诊断模式」。开后落点：助手气泡挂「复制 trace id」动作（DEV 恒开）+ run 详情「诊断信息」区（上段：run / agent / 执行 / trace id 等底层标识，对回服务端日志）。**深层诊断指标（部分落地）**：调度 `BatchMetrics` ✅——WaveScheduler 每批快照经 `batch_metrics` SSE 折进 `execution.batches`，run 详情「诊断信息」渲染「调度」块（节点 / 上限 / 峰值、平均并发=`busyMs/wallMs`、完成·失败·跳过、槽位等待、自我纠偏边界=绑定/操舵/复核、队员上报），多批（checkpoint/scope 让渡续跑）按「批次 N」分段；收敛 `turn_metrics`、单 run 的 LLM 窗口/prompt 仍 ⏳ 待后端经 SSE/接口暴露（见 §十五）。→ 见代码 `stores/ui.ts`（`diagnosticMode`）、`pages/more/AboutSettings.tsx`、`lib/paletteCommands.ts`、`components/chat/detail/RunDetailBody.tsx`、`components/chat/message-bubble/AssistantMessage.tsx`。

**委派展示统一**：单一可视化（`GraphView` 一张图同表委派树与 `depends_on` 依赖）+ 单一数据模型（`AgentRun`：编排步骤与委派子 Agent 共用同一节点类型）+ `run_*` 事件族（前端不拼接两路流）。**被否决**：前端按 N 隐藏其一（状态仍分叉）；保留双协议只在前端合并（双写漂移）。

**run-detail「委派关系」区段**（阶段2 嵌套委派）：worker 详情在「协作关系」（`dependsOn` 上游 依赖 / 下游 后续，横向同波次）之外另设「委派关系」区段——「上级」是委派它的 captain worker（仅当父 run 是本回合图上的真实节点才显；顶层 worker 的父是 CEO captain、图上无节点，故为空），「子任务」按 `parentRunId` 递归缩进成树、点行下钻该子 run。两者**并列而非混淆**：DAG 边横向（同波次依赖），委派边纵向（嵌套层级）。→ 见代码 `RunDetailBody.tsx`。

**聊天紧凑化原则**：inline 只做信号展示（思考折叠条/状态条/内嵌协作图）；面板承担完整详情（思考全文/run 全文 + 工具 IO + 用量）；失败/运行中强制展开（错误绝不藏）；协作图内嵌于回合（非面板 Tab），大图 / 回放进画布放大态。

---

## 十一、Agent 可发现性 ✅ 已确定

可发现性是 Agent 的固有属性，单独成轴，不从「被哪个团队引用」反推。三态：`public`（上架，进发现/搜索，并入 CEO **智能路由**的可用人才池）、`unlisted`（后台构件，不进发现面但按 id 可直达）、`private`（仅创作者可见）。**可发现 ≠ 用户手选**：可发现只是把 agent 喂进 CEO 的人才池由智能路由自动组团，**不给用户开「选择器」菜单**（手选 = 替代 CEO 调度、制造双决策逻辑，已否决）。

**设计原则**：单一谓词（一处过滤 `visibility=public` 覆盖全部发现入口）；`is_featured` 解耦（回归「编辑精选」本职，与可见性正交）；缺省 public（避免误隐藏）；组件型默认 unlisted（团队成员/captain/竞技场角色）。

**被否决**：把辩论/对抗角色拆成**给用户手选的独立实体**——违背 Multi-Agent First；辩论由 CEO 自动调度、主持人驱动（§四），主持人 / 辩手不进发现面、不给用户手选，无独立 Arena 实体或槽位。

---

## 十二、工具箱（卡片网格）

> **已落地**：工具箱页（`/toolbox`）为卡片网格 IA（→ 见代码 `pages/ToolboxPage.tsx`）；「能力」组下两张直达卡片——**工具**（`/toolbox/tools`）、**AI 提示词**（`/toolbox/guidelines`），各进专注子页、共享一次 `/v1/capabilities` 拉取（→ 见代码 `pages/toolbox/{Tools,Guidelines}Page.tsx` + `components/tools/`）。技能（系统 Skill）并入「AI 提示词」页作「工具进阶用法（薄技能）」一节，不再单列卡片（决策见下）。本节为关键决策；工具/产物模型见 [`工具与能力系统.md` §3.4](/docs/03-AI核心/工具与能力系统.md)。

工具箱页用**卡片网格**（`auto-fill minmax(260px,1fr)`，磁贴：图标居左 + 标题/副文 + 右侧 `›` 或「即将上线」徽章），按三组**轻量小标题（非 Tab）**排布：

- **创作工具**：文档 / 思维导图 / 多维表格 / 画布 / 幻灯片 / 可运行产物 / 流程图 / 表单——各为一种产物类型，点击进「该类型产物列表 + 新建」。
- **能力**：工具（`/toolbox/tools`：Agent 可调用动作工具，含 CEO/队员可用性 + 调用参数）/ AI 提示词（`/toolbox/guidelines`：系统提示词模板〔全员准则 + CEO 完整提示词〕+ 工具进阶用法（薄技能）〔系统 Skill 正文〕）/ 集成 · 连接器（MCP & 第三方）/ 工作流（编排工具 + Agent）。
- **了解平台**：产品手册（`/toolbox/manual`，沉浸式全屏、左侧目录 + 阅读列；唯一入口，四组——开始 / 核心功能 / 运行机制 / 进阶 & 帮助；「运行机制」组即原团队运行机制并入，详见 §五）。

**关键决策**：分组用小标题而非 Tab——工具箱落地页一屏纵览全部能力组、零层级切换；**「了解平台」与「能力」分立**——产品手册是说明 / 透明页、既非创作工具也非「可被编排进团队」的能力，单独成组以免污染「能力」组语义（**否决**塞进「能力」组）。**了解平台收敛为单一入口「产品手册」**——原独立「团队运行机制」页（`/toolbox/mechanism`）已并入产品手册「运行机制」组（**否决**两张并列卡片：受众都是「想看懂平台」，并列徒增入口噪音；机制内容随手册一站可达）。**「AI 能力」中转页拆为直达卡片**——原 `/toolbox/ai-tools` 把工具 + 技能 + 准则堆成一页纵览，随工具数增长（20+ 工具分七类 + 技能 + 两整段系统提示词）长页扫读成本高、单组件混关注点；现「能力」组直接给出各进专注子页的直达卡（**否决**早期「一页纵览」：长页扫读差；**否决**保留「AI 能力」做二级中转 hub：徒增一层点击，直达卡片路径更短）。**能力图鉴收敛为「工具 + AI 提示词」两类（技能并回提示词层）**——曾短暂拆为工具 / 技能 / 准则三张并列卡，但「技能」与「工具」并列既撞车又违背术语表：6 个系统 Skill 全是「某内置工具的进阶用法指引」、本质是 **Prompt 注入**（[`术语表.md` Agent-Skill-Tool 三层模型](/docs/01-产品/术语表.md)），并非独立于工具的领域能力；故技能并回「AI 提示词」页作「工具进阶用法（薄技能）」一节，能力图鉴只留**工具（确定性代码）+ AI 提示词（含准则与技能）**两类，顺带把 `consult_skill` 归 `ToolCategory.ORCHESTRATION`（消除工具页里只含它的「技能」分组）。**否决**保留并列「技能」卡（与工具撞车、违术语表「Skill=Prompt 注入」）；**否决**把系统 Skill 当竞争资产藏起来（透明度不丢——仍在 AI 提示词页完整公开）。当前 6 个系统 Skill 属**单工具薄技能**（一对一贴着某内置工具的进阶用法、≈ 加长版工具说明书）；等真正的**多工具域级 Skill**（合同审查 / 数据分析等独立于工具、自带领域知识 + 编排多工具的领域能力）出现，再为其立独立技能目录（单工具薄技能 vs 多工具域级技能 的光谱见 [`术语表.md` Agent-Skill-Tool 三层模型](/docs/01-产品/术语表.md)）。**现状**：工具 / AI 提示词 两张能力卡 与 产品手册（含运行机制）已落地，集成 · 连接器、工作流及各创作工具为占位（「即将上线」）；各创作工具的编辑器与「产物列表 + 新建」流程归 `file` / `table` 体系，多为 Post-MVP（见 [`工具与能力系统.md` §3.4](/docs/03-AI核心/工具与能力系统.md)）。

**关键决策 · 能力透明分层公开**：AI 的工具 / 技能 / 提示词**对所有人公开**，分三层渐进披露，「默认结构化、一键见原文」——L1 能力图鉴（静态全景，分工具 / AI 提示词两张子页：工具含 CEO/队员可用性 + 调用参数、AI 提示词展示系统提示词模板〔全员准则 + CEO 完整提示词〕+ 工具进阶用法（薄技能）〔系统 Skill 完整正文〕，两页共享同一次 `/v1/capabilities` 拉取）；L2 运行过程（`consult_skill` 在过程时间线/队员详情里渲染为「查阅能力」卡，见 §一B）；L3 本回合上下文（每条 AI 回复 hover → 「收到的上下文」打开弹窗，含**逐字**系统提示 / 对话历史 / 原始请求 等 `run_context` 块、对所有人可见，与喂给模型同源；原独立「提示词」按钮已并入此弹窗）。**否决**「把原文当竞争资产藏起来 / 仅对开发者开放」——对齐产品「真实协作、可被看懂」的心智；原文展示用弹层/折叠承载，不污染默认结构化视图。注意：这与 §五「产品手册页否决页内开发者细节开关」不冲突——后者只约束**手册页**保持纯用户向，原文透明落在能力图鉴与消息两处独立界面。

**Prompt 结构化渲染（开发者）**：系统提示词 / Skill 正文常带 `<tag>…</tag>` 分段标记。桌面端统一走 `components/prompt/PromptDocument.tsx`——`lib/parsePromptDocument.ts` 按 XML 标签拆段（无标签则整段 Markdown），`lib/promptTagLabels.ts` 把已知 tag 映射中文标题；组件提供「渲染 / 原文」切换，供能力图鉴（`/toolbox/guidelines`）、`consult_skill` 结果卡、`ReceivedContext` 弹窗复用。新增服务端 prompt 段 tag 时同步补 `PROMPT_TAG_LABELS`。

---

## 十三、模型配置（替代质量档）

质量档 UI 已永久移除（`经济档`/`高质量档` 预设、设置页质量档、`ModeSelector`、相关词表/缓存）。用户改为在 **More → 模型配置** 配一个 OpenAI 兼容端点：

- **三字段**：API Key、Base URL（含 `/v1` 前缀）、默认模型名
- **测试连接**：probe 连通性 + `supports_tools` 能力标记（✅ 支持工具调用 / ⚠️ 仅对话）
- **输入区**：`CurrentModelBadge` 只读展示当前模型，无切换入口
- **工具门禁**：`supports_tools=false` 时委派/辩论入口灰显 + 引导换模型（soft gate——probe 失败不 hard block 聊天）

全链路（聊天、委派、辩论）统一用该模型；场景差异（温度、回合预算等）由引擎内部画像处理，用户不可见。后端决策见 [`编排器与CEO主Agent.md` §2.1](/docs/03-AI核心/编排器与CEO主Agent.md)；BYOK 用量呈现见 [`前端成本呈现.md` §7.4](/docs/04-前端/前端成本呈现.md)。

→ 见代码 `pages/more/ModelSettings.tsx`、`components/chat/message-input/CurrentModelBadge.tsx`、`components/llm/ToolsCapabilityBadge.tsx`。

---

## 十四、全局搜索与命令面板（现状）

`Ctrl/Cmd+K`：Tier 1 关键词搜索 + Tier 2 命令导航 ✅。空查询显最近对话+命令；有查询 300ms 防抖后端搜索；消息命中走 load-around。入口为 TitleBar / Web 侧栏 **假输入框**（`SearchTrigger`，文案「搜索或运行命令…」），侧栏不放真输入框。

**搜索 / 筛选 / 查找 三层用词**（✅ 组件已收口）：

| 词 | 场景 | 示例 |
|---|---|---|
| **搜索** | 仅全局 `Cmd+K` | 跨对话、消息、文件夹、命令 |
| **筛选** | 当前列表/树客户端过滤 | `/conversations`、文件工作区、IM 会话列表、`@` 弹层 |
| **查找** | 当前视图内定位 | `Cmd+F` 已加载消息；IM「查找联系人」 |

会话内 `FindBar` 无命中时引导「在全对话中搜索」并预填关键词打开命令面板。

技术契约 → [`前端技术与架构.md` §9.8](/docs/04-前端/前端技术与架构.md)。组件规格 → [`UI-Pattern索引.md`](/docs/04-前端/UI-Pattern索引.md)。Tier 3 语义搜索 ⏳ → [`远期规划 §三`](/docs/06-规划/远期规划.md)。

---

## 十五、待定事项

| 议题 | 说明 |
|------|------|
| 移动端适配 | 图视图在手机端如何简化 |
| 多任务同时进行 | 多个任务并行时图视图如何呈现 |
| 历史任务回放 | 图视图内帧流回放已落地（`Timeline`）；跨会话回放完整历史任务待定 |
| 无障碍访问 | 图视图的键盘导航和屏幕阅读器支持 |
| 离线态 UX | 已连接但目录不可达时的降级展示 |
| 深层诊断指标 | 诊断模式骨架 + 调度 `BatchMetrics` 已落地（§十，run 详情「调度」块）；收敛 `turn_metrics`、单 run 的 LLM 窗口/prompt 待后端经 SSE/接口暴露后挂入 run 详情/回合 meta ⏳ |
| 空对话引导 | ✅ 空态仅保留主标题「今天想解决什么问题？」；场景模板卡片已否决（与手机端、宣传素材对齐） |
| 流式文字平滑追加 | 正文按 2–3 字一组平滑追加的微动画（现 `streamingMarkdown.ts` 为逐块切分、无字符级动画） |
| 对话自动标签 | 对话按类型（代码审查/研究/写作/分析）自动打标，供侧栏/检索筛选 |
| 消息收藏 bookmark | 消息级收藏 → 侧栏「已收藏」聚合（现 `MessageActions` 仅删除） |
| 搜索过滤器 | `Cmd/Ctrl+K` 搜索结果按时间/工作区/标签过滤（现为无过滤器关键词搜索，§十四） |
