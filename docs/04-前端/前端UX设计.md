# 前端 UX 设计

> **状态**：已确定方向
>
> 本文记录**已落地现状 + 关键决策（含被否决方案）**。工作区面板 chrome（文件即主体 IA）见 §十；`FileSource` 抽象（对话工作区面板 + @ 提及共用一套）见 [`前端技术与架构.md` §8.7](/docs/04-前端/前端技术与架构.md)。

---

## 核心设计理念

用户心智模型是「掌管一支由 AI CEO 带队的 Agent 团队」（你是老板，团队替你跑），UI 是用户感知这一心智模型的唯一窗口。设计需在「零门槛入门」和「差异化体验」之间取得平衡。设计原则（零门槛、渐进揭示、简单任务零噪音、临时全屏无损等）贯穿 §一。

---

## 一、全局布局与团队展示

全局采用 **侧栏 + 页面级自定义布局**（详见 [`前端技术与架构.md`](/docs/04-前端/前端技术与架构.md) §五）。核心对话页为单栏聊天区：

```
/conversations/:id（单栏聊天区）
  消息流（多 Agent 回合：助手消息内嵌 InlineTeamGraph）+ ApprovalPrompt（工具审批）
  └ MessageInput（底部固定）
内嵌图右上「最大化」→ 临时全屏（TeamGraphFullscreen，含回放 Timeline + 大画布）
点图节点 → 右侧 SidePanel 新开该 run 的详情 tab（被动下钻）；面板是一条扁平 tab 栏——固定首位「工作区」tab（文件/快照）+ 按需的 run 详情 tab。右上「侧面板」开关 / Ctrl+I → 显隐（冷启动落「工作区」tab），Ctrl+J → 直达「工作区」tab
```

**侧栏对话区（IA · 两区混合「方案 B」）**：侧栏对话区分两区——上工作区（按文件夹的可折叠分组：组头显云/本地图标·名称·计数，组内复用 `ConversationItem` 列 Top 5、超出走「更多」跳 `/conversations` 并聚焦该组）+ 下裸聊扁平列表（仅未归属文件夹的对话，置顶优先、当前裸聊对话恒可见，**上限自适应**：无工作区分组时独占侧栏给足 15、有分组时放宽到 10，溢出均走「查看全部对话」——侧栏单层外滚，不另设嵌套滚动条）+ 底部「已归档 (n)」（有归档时显示，跳转 `/conversations` 并聚焦已归档视图）+「查看全部对话」入口。**对话行操作**：hover 为整理主路径——重命名 + 归档 +「更多」（置顶 / 移到 / 分享 / 导出 / 永久删除）；归档成功 toast 5s 内可撤销；右键菜单同集。**归档 vs 删除**：归档可取消、仅从活跃列表隐藏；删除对用户为永久（后端 soft-delete 保留期不暴露回收站 UI）。批量归档 / 永久删除与「30 天未活跃」快筛仅在 `/conversations`。**两区无文字标题**——组头（chevron + 图标 + 计数）与裸聊平铺行视觉已足够区分；两区并存时以细分隔线隔开。**工作区 ⊥ 裸聊 · 干净二分零重复**：已归属对话只在其工作区组里、**不**在裸聊区重复（**否决**跨区「最近」列表：双显噪音>收益）；裸聊只在下方扁平区（**否决**为裸聊单设「未分组」组：徒增空组噪音）。全部对话都已归属时裸聊区整体隐藏（0 对话则走空状态）。工作区组按近活跃排序、上限 6（溢出走「查看全部对话」），每组展开态按 `folderId` 持久化（`useSidebarStore`，显式切换优先；无记录时默认折叠、唯含当前对话的组自动展开）。分组逻辑下沉纯函数 `buildWorkspaceGroups`。完整列表与「按文件夹筛选 / 页内搜索」收敛到**对话管理页** `/conversations`；文件夹生命周期归「文件」中枢 `/files`。**决策**：侧栏保持轻量——裸聊 10/15 自适应、每组 Top 5、组数 ≤6，低频整理移交专门页面。**「对话」导航即「新建对话」**：点顶部「对话」入口默认开空白草稿（`Ctrl/Cmd+N` 同效），回到旧对话走侧栏列表 /「全部对话」；路由 `/` 是新草稿唯一真相。→ 见代码 `lib/newConversation.ts`、`pages/ConversationPage.tsx`、`components/sidebar/RecentConversations.tsx`、`components/sidebar/WorkspaceGroups.tsx`、`hooks/useWorkspaceGroups.ts`、`stores/sidebar.ts`、`pages/ConversationsPage.tsx`。

**团队展示并入「思考·正文·工具」时间线**：多 Agent 与单 Agent 回合都走同一条内联时间线（`ProcessTimeline`，§一B）——CEO 的思考、回复正文、工具按真实发生顺序交织。多 Agent 委派时，一张协作图（`InlineTeamGraph`）**内嵌在 `delegate`/`debate` 步的时序位置**承载团队界面：图顶状态条折进了原任务卡片的职责（状态 · N agents · M/M · 用时 · ¥合计 + 救火行），节点 face 只显角色 + 任务/输出 + 用时/工具（¥ / token 归 run 详情，§7.3B），点节点把详情下钻到右侧被动面板，右上「最大化」临时进全屏看大图/回放。CEO 委派前后的思考/正文/自调工具因此围着团队工作按真序排列，不再被压到固定图下方；单 Agent 回合不出图（无团队）。思考逐段可折叠＝零噪音，末段正文即最终答案；live 与重载一致——多 Agent `process[]` 已持久化、经 `journal` 回放，仅持久化前的旧回合回退到独立图布局。→ 见 [`前端技术与架构.md` §9.2–9.6](/docs/04-前端/前端技术与架构.md)。

### 一B、单 Agent「思考·正文·工具」内联时间线 `ProcessTimeline` ✅ 已落地

单 Agent 回合 CEO 直接调工具（联网搜索 / 读网页 / 检索代码 / 执行）时，气泡把 CEO 的**思考、回复正文、工具调用**按**真实发生顺序**交织成**一条内联时间线**（Cursor 式全内联）：思考段＝灰色**可逐段折叠**小块（流式中展开看它边想、完成自动收起＝零噪音），正文段＝正常富文本（含行内引用 `[n]`），工具＝一行（图标 · 中文名 · 参数 · 状态，点开看完整结果）；**时间上连续的 ≥2 个工具自动 coalesce 成一个可展开组**（`ProcessToolGroup`：摘要头＝分类计数「读取文件 6 · 编辑文件 2」或单类别 ≤3 时直列文件名 · 任一失败显「N 个失败」· 运行中脉冲点；**完成默认收起、流式中尾部活动组展开看它干活**，展开即原样列出各工具行、逐行仍可点开看结果），单个工具维持一行平铺。**末尾那段正文即最终答案**——不再有独立的「底部答案区」，时间线本身就是回复；流式时尾段自带光标 /「正在思考…」。与多 Agent run 详情「思考过程」区段同款折叠交互（§十 run-detail）。

- **决策与理由（为何全内联）**：单 Agent 回合每轮 `思考→正文→工具` 交替（ReAct），**忠实时序优先**——正文回归它在思考/工具间的真实位置；噪音改用「思考逐段折叠」兜。仍被否决的是**常驻、打碎正文的吵闹工具卡**（§二 C）——本方案工具行紧凑、思考可折叠，噪音可控。
- **决策与理由（连续工具折叠 `ProcessToolGroup`）**：CEO 连读 10 个文件曾平铺成 10 行 `读取文件`，满屏噪音。对齐 Cursor「Read N files」/ Claude「Researched…」的行业做法——把**时间上连续、被思考/正文打断即断组**的工具并成一条「动词＋计数」可折叠摘要，**保序**（思考/正文天然作分隔，不打碎时序，故未取「按类别全回合归桶」那种碎序方案）。纯**渲染层 fold**（`lib/processTimeline.ts` 的纯函数 `groupToolRuns` + 桌面 `ProcessToolGroup`），`process[]` 形状不变 → **不动后端 / `turn_journal` / conformance**；**末段正文（最终答案）是 `content` 步、永不进组**，答案绝不会被折叠藏起来。阈值＝连续 ≥2 才折（单个保持平铺）。手机端 `AssistantView` 是另一套实现、本次不含（分组是 chrome、非协议 fold）。
- **保序持久化**：时间线随回合持久化（后端落 `turn_journal`，读取投影为 `runs.process` 载荷），刷新可回放。→ 见代码 `components/chat/MessageBubble.tsx`、`services/streamConversation.ts`
- **「正在生成 {工具}…」实时行 `ComposingToolLine`**：CEO captain 拼装大工具调用参数时，时间线尾部一行实时显示「正在生成 {工具} · N 字 ▋」——补 `tool_use_start` 之前的空白期。**纯传输、不持久化**。
- **回合结束原因 chip `finishReasonChip`（✅ 已落地）**：回合收尾时气泡**顶部**按 `finish_reason` 挂一枚状态 chip，框住非正常收尾——`max_rounds`（已达最大轮次）/ `degraded`（降级完成·模型多次空响应）/ `unproductive`（无有效进展）三种降级收尾用琥珀 `warning`，用户/断线 `cancelled`（已中断·已保存完成的部分）用 `muted`（遵 `color-tokens.mdc`）；`end_turn` 正常回合不显，`error` 交由错误卡承载（不重复套框）。chip 跨**单 + 多 Agent** 回合（立在时间线/协作图上方）。直播取 `message.finishReason`；**回放**多 Agent 从 journal `runs.finishReason`、单 Agent 从回合级 `turn_end` 回落——非正常收尾的回合即便无图/无进程，也由持久化兜底补写一条最小 `turn_end`，故 `max_rounds`/`degraded`/`unproductive` 重载后照样挂 chip（✅ Tier 2 c）。气泡 hover meta 行另随成本展示回合 token 用量 + 轮次，见 [`前端成本呈现.md §7.3A`](/docs/04-前端/前端成本呈现.md)。
- **回合内联错误卡（✅ 重载回放，Tier 2 a）**：报错回合的 `{code, message}` 直播时走**纯传输** `error` SSE（不入 journal）→ `message.error` 渲染内联错误卡。**重载**则从 `turn_end` 携带的 `error` 投影回 `runs.error` → `toMessage` 映射回 `message.error`，回放同一张卡（含正文为空的报错回合：后端为其补写**空正文消息行 + 最小 journal**，空正文被 history 过滤、不污染后续上下文）。`code` 仍走 `lib/errors.ts` 单点翻译（PIPELINE_ERROR 无补救动作、仅展示）。→ 见代码 `services/messages.ts`（`toMessage`）、`runtime/journal.py`（`turn_end` 投影）、`conversation/service.py`（`_persist_turn_result` 反常回合落库门）。

| 形态 | 何时 | 职责 |
|------|------|------|
| 内嵌协作图（主） | 多 Agent 回合，随消息常驻、刷新可回看 | 状态条（进度/成本/救火）+ DAG + 节点用时/工具 |
| 临时全屏（按需） | 点内嵌图「最大化」 | 大画布 + 回放 Timeline + 节点详情 |
| 右侧 SidePanel（被动） | 点图节点才新开 run tab | 一条扁平 tab 栏：固定「工作区」tab + 按需 run 详情 tab（单 run 全文，可多 run 并存对比） |

> 信息分层（Layer 0–4 模型）：单 Agent 回合 = 一条内联「思考·正文·工具」时间线（§一B，思考/工具＝Layer 1–3、末段正文＝Layer 0 输出，按真实顺序交织）；多 Agent 回合 = 内嵌图（Layer 1–3 状态/进度/协作）+ 点节点进面板看 run 全文（Layer 4）。

**聊天特有元素**（检查点 / 非阻塞发问 / 结构化挂起 / 断连续跑 / 工具审批等）→ 见代码 `components/chat/`；消息载入契约见 [`前端技术与架构.md` §9.7](/docs/04-前端/前端技术与架构.md)。**已否决**：Slash 命令、Agent/Team 选择器、产物 Pill、常驻吵闹工具卡（每回合落点 pill 式噪音）。**草稿期「工作区」选择 chip 已落地**（默认「自动」零门槛、可选落点文件夹；与被否决的「每回合落点噪音」相区别，详见 §九）。

> 页面宽度 → 见 `.cursor/rules/desktop-layout.mdc`；对话页 / 文件页自有布局除外。

---

## 三、内嵌协作图与状态条（现状）

多 Agent 回合的团队界面是内嵌进助手消息的协作图（`InlineTeamGraph`，→ 见代码 `components/chat/InlineTeamGraph.tsx`）：图顶一条**状态条**按 `execution.status` 分四态渲染，下方是可折叠的协作图（`GraphView` 内嵌形态），右上「最大化」进临时全屏。状态条吃下了原任务卡片的全部职责（AgentCore 聊天界面与普通对话 AI 的核心视觉差异点）：

- **执行中**（`RunningStrip`）：转圈 + 任务摘要 + 进度 `completed/total` + 进度条；尾部控件（停止 / 折叠图 / 全屏）。Agent 状态/工具/输出在下方图节点上呈现。
- **已完成**（`CompletedStrip`）：一行战绩「团队完成 · N 个 Agent · M/M 子任务 · 用时 · ¥合计」（用时取帧流挂钟跨度 `elapsedMs`，¥ 取 `message_end` 回合合计 §7.3A）。**部分失败**（CEO 完成但有 worker 失败）额外显示琥珀色「N 个子任务失败」横幅 + 救火行。
- **已停止**（`status=cancelled`）：同战绩形态，「已停止」标题，在跑节点冻结为 cancelled（不再转圈），救火行显示「已花 ¥」。
- **失败**（整轮崩溃，`FailureStrip`）：高亮失败 Agent / run + `run_failed` 错误原因 + 救火行。

救火行（`RecoveryActions`）由失败条、部分失败的已完成条、已停止条共用——重试（从最后一条用户消息整轮重新执行）/ 调整指令（内联编辑后重发）/ 放弃（清空该回合执行槽）。状态条尾部为一级图标按钮：执行中给「停止」、已完成/已停止给「回放」（进全屏自动播放时间轴），外加常驻的折叠 / 全屏；不设 `[···]` 菜单——整轮重新执行统一交给消息级「重新生成」与救火行「重试」。内嵌图块在 `run_plan` 首次挂载时播放一次入场动画（`animate-task-card-enter`，遵循 `prefers-reduced-motion`，见 `styles/globals.css`）。

**出现时机规则**（核心决策）：

| 场景 | 行为 |
|------|------|
| 简单任务（CEO 直接回答，无 plan） | **不出图**，直接流式输出，体验同 ChatGPT |
| 多 Agent 任务（CEO 调用 `delegate`） | `run_plan` 到达时**自动内嵌**于助手消息上方 |
| 任务完成 | 状态条**收缩**为一行战绩摘要 |
| 用户停止任务 | 状态条转「已停止」，在跑节点冻结，提供重试 |
| 用户发新消息 / 刷新 | 每条回答各持自己的执行槽（按 `messageId` §9.3），历史图保留，刷新后从 `message.runs` 回放 |

**为何无「规划中」态**（决策）：CEO + `delegate` 架构下 `run_plan` 同步到达，无独立规划空窗；「系统在思考」由 CEO reasoning 气泡覆盖；`tool_use_start(delegate)` 前无法预知是否组团，故状态条不设「规划中」态。→ 见代码 `delegate.py`、`engine.py`。

**检查点卡片（已落地）**：CEO 调 `ask_user`（默认 `blocking=true`）暂停回合、请用户拍板——会话流内独立卡片，刷新后随消息回放。**语气按内容自适应**：开场味 = 蓝 `primary`／「就这样开做」；途中味 = 琥珀 `warning`／「提交」。两动作：**提交**续跑 / **停止**优雅结束本回合。卡片仅在 live 挂起时可操作，历史回合只读。

→ 见代码 `components/chat/CheckpointCard.tsx`（`AskUserCard`）；语义与 API 见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

> **为何两态而非三态**（决策理由）：「继续/调整」效果同一，合并为「提交」；保留「停止」安全阀。详见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

**非阻塞发问卡片 `NonBlockingAskCard`（✅ 已落地）**：CEO 调 `ask_user(blocking=false)` 时**不挂起回合**——语气取**品牌蓝 `primary`**，展示问题 + 默认假设 + 选项 **回填 chips**（点 chip 写进输入框，随下一条消息发回）。从不挂起、无 pending/resolved 态。

→ 见代码 `components/chat/NonBlockingAskCard.tsx`；语义见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

**结构化挂起卡片 `PlanReviewCard`（✅ 已落地）**：DAG step 带 `checkpoint_after` 时，调度器在**波间**暂停——区别于 CEO 主动 `ask_user`（`kind=plan_review`）。卡片展示已完成步骤 + 待运行下游预览；**继续 / 调整 / 停止** 三按钮（`adjust` 备注注入未跑下游，仅备注非空时可点）。三态：**pending** / **dormant** / **resolved**。

→ 见代码 `components/chat/PlanReviewCard.tsx`；语义见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

**断连续跑卡片 `ResumePrompt`（✅ 已落地）**：结构化挂起回合断连/重启后，渲染在**输入框上方**的「待恢复」卡片（内容同 `PlanReviewCard` 或 `AskUserCard`），**继续 / 调整 / 停止** → `POST …/messages/{mid}/resume` 走 SSE 续跑。

→ 见代码 `components/chat/ResumePrompt.tsx`；语义见 [`执行引擎架构设计.md` §暂停与恢复](/docs/03-AI核心/执行引擎架构设计.md)、[`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

> **勿与两个近邻混淆**：① **工具审批**（`approval_required`，GRANTABLE 工具授权）是另一套、渲染在输入框上方而非消息内；② **CEO 主动 `ask_user`** 与 **DAG `checkpoint_after` 结构化挂起**是不同机制（前者 CEO 运行时自决，后者调度器波间闸门）——二者 UI 形态相似但数据通路与 resolve kind 分离。`TeamPreviewCard` 团队预审 gate（执行前预览团队）仍 ⏳ Phase 2 preflight，见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

---

## 四、辩论/审查范式

> ✅ **已落地**：辩论从「`stance`/`round` 展示标记 + CEO 手搓 DAG」升级为「**主持人（Moderator）驱动的逐轮交锋 → 决策简报 + 交锋叙事线双产物**」。完整设计（主持人循环 / 三形态 / 收敛轮次 / 技术落点）见 [`辩论编排设计.md`](/docs/03-AI核心/辩论编排设计.md)；本节聚焦**前端呈现**。

### 4.1 双产物呈现（✅）

辩论回合产出两样、**都是一等**（用户拍板「过程本身也有用」），收场事件 `debate_result` 承载，呈现顺序按形态自适应（`narrative_first`）：

- **决策简报**（结论）：争议焦点 / 各方最强论点（按 `sides` 一方一格）/ 事实分歧 vs 价值分歧 / 主持人倾向 + 置信度 / 建议 / 待用户拍板点。
- **交锋叙事线**（过程，三层渐进披露）：**L1 焦点小结流**（每轮一句焦点 + 裁判徽章，串成认知推进线）→ **L2 主持人小结 + 裁判理由**（真交锋 / 有无新论据 / 是否收敛）→ **L3 各方发言全文**（懒展开，靠 `run_id` 关联辩手节点取全文、点角色下钻右侧详情）。
- **顺序自适应**：决策类（正反/红队）简报先行、叙事线紧随可展开；探讨类（多方圆桌）叙事线先行、简报作小结收尾。

三形态（正反辩论 / 红队挑刺 / 多方圆桌）共用同一呈现骨架，参与方泛化为「立场标签」（`sides[*].name`，不再硬编码正/反）。

→ 见代码：桌面 `components/chat/DebateCompare.tsx`（`DebateProducts` = 简报卡 + 三层叙事线；进行中 / 旧 journal 回落 groups 兜底）、手机 `apps/mobile/src/components/DebateView.tsx`（精简双产物）。

### 4.2 团队图上的辩论标记（✅）

差异化呈现（仅辩论回合触发，普通并行批次零变化）：

| 处 | 现状 |
|----|------|
| 范式标题 | 内嵌图状态条显「辩论」pill、完成态作「辩论完成」（普通为「团队完成」）——`InlineTeamGraph`（`isDebate` = 有 `debate` 产物或有 `stance` runs） |
| 节点 badge | 对立节点显「正方/反方」徽章（`primary` 令牌，与 6 态状态色解耦）——`AgentNode` |
| 图分列对置 | 正/反节点按 `stance` 排序 + ELK `considerModelOrder`，分两带对置——`GraphView` / `lib/elk-layout.ts` |
| 节点层级 | CEO（主气泡，不进图）→ 主持人（完成态节点）→ 辩手（挂主持人下），见 [`辩论编排设计.md §7.3`](/docs/03-AI核心/辩论编排设计.md) |
| 产物卡 | 图卡下方一张辩论产物卡（§4.1）：收场渲染【简报 + 三层叙事线】；进行中 / 旧 journal 回落「按 `group` 分组、`正方 \| 反方` 两栏并排」实时对比兜底——`DebateCompare` |

### 4.3 老板介入与收尾（✅ 机制复用 / ⏳ 逐轮语义化）

辩论收尾与中途介入**复用现有 `ask_user` / `plan_review` 检查点**（✅ 机制已落地，见 §三），无新检查点类型。⏳ 逐轮语义化（每轮小结后按形态可选「继续辩 / 加一个角度 / 聚焦到 X / 够了出结论」）依赖主持人 `on_round` 回调，当前收场一次性出产物、逐轮实时介入留作后续。

> **决策演进**：「主持人是 CEO 之下、辩手之上的一层、底层无 debate 专用执行路径」**仍成立**——只是这层落成 `debate` 工具内的确定性循环 + 图上完成态节点，而非一个 LLM 委派角色（理由见 [`辩论编排设计.md §7.1`](/docs/03-AI核心/辩论编排设计.md)）。旧「多轮 = CEO 手搓跨轮 DAG」**被替代**，见 [`辩论编排设计.md §八`](/docs/03-AI核心/辩论编排设计.md)。

---

## 五、图视图（现状）

**内嵌静态 + 临时全屏探索**（核心 UX 规则）：内嵌 `GraphView`（`embedded` 形态）为**静态预览**——禁缩放交互，滚动对话而非缩放画布；点「最大化」进临时全屏做缩放/平移/回放。内嵌 fit-to-width 定高，节点 face 三层：角色 → 在干什么 → 用时/工具（**¥ / token 归 run 详情**，§7.3B）。点节点下钻：内嵌图开右坞 `SidePanel` run 详情 tab；**全屏图则在画布右侧就地开 `GraphDetailPanel`——worker 详情复用同一 `sidePanel` store（节点高亮、退出全屏后右坞展示同一 run），端点（用户输入 / CEO 汇聚点）就地渲染提问 / 最终回答正文（全屏本地态，非 run）。点任意节点都不退出全屏、详情在旁展开，画布随面板开合自动重适配；Esc 渐进收起（先收详情、再退全屏）。内嵌图的端点点击仍跳对话气泡（气泡就在阅读列内，无需面板）**。

→ 见代码 `components/graph/GraphView.tsx`、`components/graph/`

**嵌套子团队**：子 worker 经虚线委派边挂 captain 下，带「子任务」徽章；**否决容器嵌套盒**。→ 见代码 `lib/elk-layout.ts`。

**角色身份（✅ 已落地）**：每个队员节点的头像 = 按角色名**稳定派生**的「颜色 + 首字字形」（`lib/agentIdentity.ts` 用 FNV hash → `--agent-1..8` 身份色板，CJK 角色名首字即天然字号头像「研/工/设」），让一支团队读作「一个个人」而非一排同款 Bot 图标。**身份与状态解耦**：身份在头像盘，运行状态走卡片色环 + 头像角标的「在线点」（运行/完成/失败带小字形，保留非颜色线索），故身份色永不与 6 态状态色抢色（见 `.cursor/rules/color-tokens.mdc`「分类色板」）。

**信息流边（✅ 已落地）**：队员间的依赖边不再只表「先后」，而是据下游 run 的 `receivedContext`（按 `source_run_id` 精确匹配上游产物块）标注**真实交接**——仅在**有损**交接（`摘要` / `递指针` / `截断`）时挂一枚小标签，`全文`（pass_through）交接保持干净线，故标签精准落在「队友只拿到了不完整产物」处；hover 标签看「来自 X · 保真度 · N 字 · 是否截断」。纯渲染层派生（`GraphView` `flowEdges` + `StepEdge` 的 `EdgeLabelRenderer`），**不改协议 fold / conformance**。→ 见代码 `components/graph/AgentNode.tsx`、`components/graph/StepEdge.tsx`、`components/graph/GraphView.tsx`。

**波次泳道（✅ 已落地）**：协作图按 `WaveScheduler` 波次（ELK 同层 = 同波）在节点后方画半透明泳道 + 「第 N 波」标签，让「团队分轮推进（并行扇出 → 汇总 → …）」一眼可读；**单波（纯并行扇出）/ 单 Agent 不出泳道**，简单回合保持干净；端点（用户输入 / CEO 汇聚点）在泳道之外。经 `ViewportPortal` 在画布坐标系渲染（泳道 z-index -1 沉底、标签浮顶），随平移/缩放联动。→ 见代码 `components/graph/GraphView.tsx`（`computeWaves`）。

**hover 速览卡（✅ 已落地）**：hover 队员节点弹一张**比 face 更详、比右侧面板更轻**的速览（角色 + 状态 + 分类标记 + 任务 + 更长的「在做 / 产出」预览 + 模型·token·用时·工具 一行），补「节点 face → 完整面板」之间的渐进披露层；复用 face 同源信号、只给更多空间，不新增数据通路。模型档/深度的小徽标 tooltip 已并入此速览（避免节点内嵌套 tooltip）。→ 见代码 `components/graph/AgentNode.tsx`。

**产物落点 chip（✅ 已落地）**：节点据自身**已提交**的文件工具调用（`file_write` / `str_replace`，按 `path` 去重、保首写顺序）派生「这个队员产出了哪些文件」，在 face 上挂文件 chip（📄 + 文件名，face 最多 2 个 + 「+N」溢出，hover chip 看全路径），速览卡列更多（至多 6 + 溢出）、aria-label 播报「产物 N 个」。**只算 `success` 调用**（失败/中止的写入不落产物），且与中行的「正在生成」分离——chip 是已落盘成果，中行是进行中的写入；纯渲染层派生（`GraphView` `deriveArtifacts`），不改协议。→ 见代码 `components/graph/GraphView.tsx`（`deriveArtifacts`）、`components/graph/AgentNode.tsx`。

**可达性与多选**：节点 `role=button` + `tabIndex` 键盘 focus + Enter/Space 激活 + `aria-label` 播报角色/状态/模型/Token/成本/用时/工具/产物；支持多选（修饰键加选 / 框选，`selected` 与面板下钻高亮共用 outline）。**动画 / 布局选型理由**：状态过渡用纯 CSS（**否决 Framer Motion**——零依赖、与 React Flow 定位 transform 无冲突）；ELK 仅留左右流 / 树形（径向 / 力导向曾实现、小团队下无价值已移除）；右键菜单复用 `sidebar/ContextMenu`（无需 Radix）。

**结构化挂起图徽标（✅ 已落地，Phase 2a）**：`plan_review_*` 事件入 journal 后，execution fold 按 step `run_id` 折进 `RunNode`；在检查点步骤的 `AgentNode` 上挂暂停徽标（⏸ + 待放行/已放行/已调整/已停止）。**否决独立 `CheckpointNode`**（step 与下游之间插入合成节点 + ELK 重布局）——视觉更突出但代价显著，徽标已满足「图上可见检查点」；独立节点留作后续 richer 形态。→ 见代码 `stores/execution.ts`（`RunCheckpoint`）、`components/graph/AgentNode.tsx`。

> 多轮辩论用普通 agent 节点（主持人 + 辩手，✅ 见 §四），无独立 arena 节点。**已否决·工具点节点**：每个工具调用单独成图节点 = 与「inline 只做信号、面板承担完整详情」+ §八 ≤50 节点性能约束冲突（一个调研 agent 调 10 次 `web_search` 即 +10 节点）；工具已被 agent 节点「工具数」+ `SidePanel` run 详情工具 IO 区段覆盖，无需独立节点。

> **运行机制（产品手册）**：`工具箱 → 产品手册 → 运行机制`（`/toolbox/manual`）。面向用户的协作透明页，用真实图组件标注机制含义；纯用户向，**否决**页内开发者细节开关。→ 见代码 `components/manual/MechanismContent.tsx`、`pages/toolbox/ProductManual.tsx`。

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

**LOD「只有聚焦回合画完整 DAG」**（守 §八 ≤50 节点 / ≥60fps）：完成的团队回合塌成「回合摘要节点」（状态 / 任务摘要 / 身份头像 / 进度）、单 Agent 回合塌成竖排轻卡，**恰好一个聚焦回合**（默认最新、自动跟随新回合、点摘要可切换）就地展开完整 worker DAG；配小地图 / 相机。聚焦回合内嵌整套 `GraphView` + 就地脚抽屉（点汇聚点读最终回答 / 点用户端点重读提问 / 表头 chip 开「版本对比」；点 worker 走右坞详情），深读兜底仍可进 `TeamGraphFullscreen` 全屏 overlay。命令栏 `CanvasCommandBar` 常驻画布底栏（与全屏图共用）。**对话页（聊天视图）恒为传统聊天**——不再把单 Agent 回合渲染成节点卡，图相关体验收敛在画布（原「对话页卡片化」第一刀已撤，见 §6.4）。

### 6.2 图上指挥：指挥台 `CanvasDecisionPanel`

画布一旦成为管团队的地方，检查点 / 发问 / 审批 / 续跑 / 救火这些**老板权力**必须能就地行使（一个「掌管团队」的视图不可能只读）。落地**不**逐个塞进节点，而是收口到画布右侧**指挥台**（面板标题「指挥台」，徽标计待裁决数）：

- **双作用域同处一面**：回合级（`ask_user` 检查点 / `plan_review` / 工作者上报 / **救火行**）随**聚焦回合**的 message + 投影执行渲染；对话级（工具放行 approval / 待恢复续跑 resume / **传输错误重试 `RetryBanner`** / **后台云端任务 `BackgroundTaskCard`**）自带 store + 当前对话自渲染。画布模式下 `ChatView` / `InlineTeamGraph` / `MessageList` 未挂载，其对话级卡片、救火行与时间线内的后台任务卡本会**消失且无法操作**——故必须在画布另起一处承载。
- **救火**（失败重试）：聚焦回合终态有失败（整轮崩 / 部分失败 / 已停止）时，指挥台渲染聊天同款 `RecoveryActions`（**重试整轮 / 调整指令 / 忽略**——重试走 `runRegenerate` 从最后一条用户消息整轮重跑、忽略清本回合执行槽，与聊天一致）；外加对话级 `RetryBanner`（发送 / 续跑 / 重生成断流的传输错误重试）。聚焦节点头另挂一枚「待救火」红牌。
- **后台云端任务**（非阻塞 · 跨对话的「另一类」）：本地模式对话的云端交接任务（`BackgroundTaskCard`，§十）原按时间戳并入聊天时间线；画布无时间线，故收进指挥台**末尾**（卡片自带派发 / 运行 / 失败状态 + 完成后「查看并应用」内联评审）。**不计入「待你拍板」**（非决策、不污染节点徽标），但其存在 / 新到一项会自动浮出指挥台；轮询同步由常驻的 `ConversationCanvas` 驱动（指挥台收起时仍刷新，故计数能反过来浮出面板）。发起侧：画布命令栏 `CanvasCommandBar` 也带「后台云端」开关（仅本地模式对话亮出），可在画布里直接派发，走与聊天**同一** `dispatchBackgroundTask` 通路、结果即落本指挥台。
- **逐字复用聊天同款卡片**（`CheckpointCard` / `PlanReviewCard` / `EscalationCard` / `ApprovalPrompt` / `ResumePrompt` / `RetryBanner` / `RecoveryActions` / `BackgroundTaskCard`，§三），操作经**同一**服务 + SSE 折叠（守单一数据源、不开第二条通路）；`interactive` 取聚焦回合 `isStreaming`，重载 / 已结束回合的卡片呈被动记录。
- 聚焦节点头部「待你拍板 N」/「待救火」提示牌指向指挥台；有待裁决项（回合级计数 + 对话级 approval + resume）、可救火（聚焦回合失败 / 对话传输错误）或有后台云端任务时自动浮出，可 X 收起，焦点切换或新项到达再武装。

### 6.3 关键决策（代码看不出的取舍）

- **双视图而非「图即唯一界面」**：原方向「无模式切换、聊天 = 图的退化渲染、最终砍掉聊天列」**已撤**——强迫简单问答上画布是负体验，且整方案命悬「画布必须像聊天一样轻」的试金石。双视图（聊天默认 + 画布 opt-in）零门槛天然、风险降到「加一个视图 + 一个开关」、**聊天永不删**；「聊天 = 图的退化渲染」只保留在数据层。
- **画布已毕业（撤实验开关）**：原 `canvasEnabled` 实验门为开发期守「画布像聊天一样轻」试金石而设；试金石已过（聊天默认零回归 + 画布 opt-in 顺滑），故撤门——入口恒显示、无需开启，免「藏命令面板后没人发现 + 永远 dogfood 不到」。每对话视图偏好随之由会话内存态**升为持久化**（`localStorage: agentcore:conversation-views`，只落画布 override、切回即删键 → 表恒收敛），刷新 / 重开对话记得上次停在画布还是聊天。
- **内嵌 DAG = 嵌套 ReactFlow**：聚焦回合把整套 `GraphView` 包进外层画布的自定义节点，靠**独立 `ReactFlowProvider` 隔离 flow store**；内层 `embedded` 弃自身平移 / 缩放、外层画布独占平移 / 缩放 / 小地图。→ 复用既有图构建，不重写第二套图。
- **聚焦节点固定高度**（`FOCUS_NODE_HEIGHT`）：脚抽屉（读答案 / 版本对比，二者互斥）与内嵌图**共享这块固定高度**（开抽屉图区缩、抽屉占下半；版本对比要并列版本列、抽屉更高 `REVISION_DRAWER_H`、图区相应再缩），节点总高恒定 → 下方回合堆叠偏移不被挤动。**否决**抽屉撑高节点（触发动态高度 → 重算堆叠）。
- **面板停靠 ≠ 节点弹层**：可裁决 / 救火卡片体量大（表单 / 备注 / 多按钮），浮节点上会挤爆 LOD 视图；故收口到右停靠**指挥台**、聚焦节点只留「待你拍板 / 待救火」提示牌指过去。

### 6.4 守住的决策 / 被否决 / 暂不做

**守住**（不因双视图推翻）：CEO 智能路由**不给选择器**（画布只让你在 CEO 组好的团队上行使老板权力，指挥 ≠ 替 CEO 组队，§十一）；节点 ≤50 / ≥60fps 靠 LOD（§八）；节点 face 极简（数字归 run 详情）；简单任务零噪音（聊天默认 + 画布退化竖排双重守住，§三）。

| 方向 | 处置 | 理由 |
|---|---|---|
| 图即唯一界面 / 无模式切换 | 撤 | 见 §6.3 |
| 对话页卡片化（单 Agent → CEO 节点卡 / 团队图聊天内就地读，原画布实验第一刀） | 撤 | 把传统对话页改成卡片是早期理解偏差；图相关体验收敛到「画布」opt-in，对话页恒为传统聊天（删 `CeoNodeCard` + `AssistantMessage.isSoloGraph` + `InlineTeamGraph` 聊天就地读） |
| 丙 · 自适应默认（按有无团队自动切模式） | 否决 | 中途翻模式 = 错愕；「何时切」判据含糊 + 每对话模式偏好状态边界多；收益小（简单回合本就退化轻卡）。改用「显眼内联入口」达成同等「画布在相关时出现」 |
| 乙-2 · 真持久团队（worker 实体化） | 暂不做 | 「团队跨回合」真需求 = 连续性 / 团队懂我，已由记忆模块 + CEO 跨回合记忆 + 共享工作区覆盖；worker 实体化撞「无选择器 / 每回合自适应组队」赌注（[`职责晚绑定与动态再编排设计.md`](/docs/07-规划/职责晚绑定与动态再编排设计.md)），是定位级（养成系）改动 |
| 跨对话 / 工作区 / 公司级空间画布 | 不在范围 | 本特性只管单对话内双视图（原『公司画布』上层提案已删除） |

**✅ 收口**：图上指挥与比对卡片已全数上画布——`BackgroundTaskCard`（云端 / 后台任务卡片，非阻塞 · 跨对话的另一类）入指挥台（见 §6.2）；`RevisionCompare`「版本对比」由聚焦回合表头 chip 唤出、就地落在脚抽屉（与读答案互斥、逐字复用聊天同款卡的 `bare` 形态，逐版本仍下钻右坞 run 详情）。至此聊天侧的指挥 / 比对卡片在画布均有归处（**定向唤回**「修订 vN」本身仍 CEO 驱动、无用户触发入口，其结果另作 `AgentNode` 节点画在聚焦回合 DAG 上）。

→ 见代码：`stores/ui.ts`（`conversationViews` 持久化、只落画布 override）、`pages/ConversationPage.tsx`（视图切换 + 偏好读取）、`chat/StatusStrip.tsx`（团队回合「在画布打开」入口）、`graph/ConversationCanvas.tsx`（持久累积 + LOD + 裁决面容纳 + 后台任务同步驱动）、`graph/TurnSummaryNode.tsx` / `graph/SimpleTurnNode.tsx` / `graph/FocusedTurnNode.tsx`（内嵌 `GraphView` + 就地读答案 / 版本对比脚抽屉 + 提示牌）、`graph/CanvasCommandBar.tsx`（常驻命令栏 + 后台云端派发）、`graph/CanvasDecisionPanel.tsx`（裁决面，复用 `chat/CheckpointCard` / `PlanReviewCard` / `EscalationCard` / `ApprovalPrompt` / `ResumePrompt` / `RetryBanner` / `RecoveryActions` / `BackgroundTaskCard`）、`chat/RevisionCompare.tsx`（`bare` 形态嵌画布脚抽屉）、`lib/agentIdentity.ts`（身份延续）。

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

**工作区删除 vs 对话整理（✅ 已确定 · 对标 ChatGPT/Codex 分层）**：**对话层**——归档（可恢复，隐藏活跃列表）/ 永久删除（用户视角不可恢复），见 §一；**工作区（Folder）层**——**不做「归档项目」**（行业亦无独立概念），侧栏降噪靠归档对话或在 `/conversations` 按文件夹批量归档。**删除项目**（`/files` · 现有 `folders` soft-delete）：仅删容器——其下对话 `folder_id` 清空并落入「未分组」、**不**删对话记录；项目文件归 Folder 所有，保留至保留期（默认 30 天，见 [`双模式工作区.md` §七](/docs/02-架构/双模式工作区.md)）后 sweeper 物理清理。**否决** ChatGPT 式「删 Project 级联删全部聊天+文件」——真实工作区（本地盘 + OSS）下对话是索引、文件是资产，级联过狠。**否决** `Folder.archived` 第三整理层。**⏳ 删除确认增强**（`WorkspaceSection`）：✅ Phase 1 — Dialog 展示「N 条对话将移入未分组」+ 项目文件 30 天保留期 + 引导用归档整理；⏳ Phase 2 — 可选勾「同时归档其下全部对话」（默认勾选）。**⏳ 「彻底删除项目」**（核按钮、另入口）：一次性清对话+文件+快照，对齐 ChatGPT Delete Project，与日常 soft-delete 分开。→ 见代码 `components/files/fileWorkbench/WorkspaceSection.tsx`、`folders.py` `soft_delete`。

**审批 UX（写操作）**：只读时尝试写引导开启；可写时写前弹审批（可「本轮内都允许」按同名工具、或「本轮内允许所有文件改动」按整类一次放行，依赖 §三工具审批三态 `grantable` 级别，避免 N 次写/改/删 = N 次弹窗）。

**对话落点表达（✅ 草稿期工作区选择器）**：新对话草稿的输入框工具行挂一枚「工作区」chip（`DraftWorkspacePicker`），默认「自动」= 桌面 local-first 懒建（零门槛不变）。下拉四项：自动 / 最近项目（按近活跃 Top 6，web 仅列云项目）/ 打开本地文件夹（复用 F2 绑定）/ 云端临时对话。**选的是落点文件夹而非云/本地**——模式仍随该文件夹绑定派生（守「无云/本地开关」）。落点经 `pendingNewChat*` 草稿态传给首发建会话（消费成 `folder_id` / `local_container_root_id` / 云端意向），故不碰发送链路与后端契约；「打开本地文件夹」先弹 OS 选择器拿桌面根，按 `localRootId` 复用已有本地项目、否则建一个（`POST /v1/folders`）。首发后归属锁定（[`双模式工作区.md` §七](/docs/02-架构/双模式工作区.md)），chip 隐藏、云/本地切换交给会话内 `WorkspaceModeBar`。web/手机无 `fsApi` → 退化为「自动（云）+ 已有云项目」。→ 见代码 `components/chat/DraftWorkspacePicker.tsx`、`components/chat/MessageInput.tsx`、`lib/newConversation.ts`。

**隐私承诺**：默认不留存（未备份内容不进云）；在途可用（读文件时正文临时发给模型）；备份/分享 = 显式上传（不自动同步，操作前明示）。

**AI 产物可编辑**：工作区面板 `.md/.markdown` 可编辑（CodeMirror + 编辑/预览切换、CAS 写盘、选区 AI 改写）。→ 见 [`前端技术与架构.md` §8.8](/docs/04-前端/前端技术与架构.md)。

---

## 十、详情面板与委派展示 ✅ 已确定

> **实现现状**：对话右侧收敛为**单一侧面板** `SidePanel`，建模为**一条扁平 tab 栏**（外壳：拖拽 resize + tab 栏 + 关闭）——固定首位「工作区」home tab（永不关闭：**文件即主体**——头栏模式 pill（点开 popover 承载云/本地切换·绑定/重连/备份到云）+ 🕘 快照（右侧 slide-over）图标浮层；交接已下沉为对话时间线卡片，不再占面板入口，见下；section 子页 tab 已删，文件树即面板主体）+ 按需的 run-detail tab（点内嵌协作图节点把该 run 钉为 tab，可并存对比，上限 6；进度/协作图已折进内嵌图，不再设 `task-progress`/`task-graph` tab）。取代原先**并排会挤爆聊天**的两个独立右坞（详情面板 + 工作区面板），并**取消早期「详情 / 工作区」段控互斥模式**——工作区本身即常驻首 tab、run 与它同栏并列，故面板永不出现空详情占位。工作区 body 首次激活才懒挂载、之后 keep-alive 不卸载（文件不重拉）。面板共享一份 `open` / `width`（280–560px）（均持久化；`section` 已删——文件常驻，快照为面板本地瞬态），run tab 集为会话级、按 `messageId` 投影对应回合执行槽。协作图节点高亮派生自当前激活 tab：激活某 run tab→高亮其节点，激活「工作区」tab（不在 run tab 集）→无高亮（守「一面一个高亮源」）；关 run tab 回退到相邻 run tab、否则落回「工作区」tab（面板不因此关闭）。打开入口：点图节点→新开 run tab、右上「侧面板」开关（`PanelRight` 图标，常驻、开启时高亮）/ `Ctrl/Cmd+I`→显隐（记忆激活 tab、**冷启动落「工作区」tab**，故手动打开即落在项目文件）、`Ctrl/Cmd+J`→直达「工作区」tab；`Ctrl/Cmd+B` 留给左侧栏折叠避免双触发。（→ 见代码 `stores/sidePanel.ts`、`components/layout/SidePanel.tsx`、`components/chat/detail/RunDetailBody.tsx`、`components/workspace/WorkspacePanel.tsx`（`WorkspaceMode`）、[`前端技术与架构.md` §9.2 / §9.4](/docs/04-前端/前端技术与架构.md)）。本节为关键决策。

> **交接 = 时间线卡片（交接「方案 B」）✅ 已落地**：「把活交给云端团队」不再是工作区面板里的居中宽模态，而是对话时间线里的「后台云端任务」卡。本地模式对话在 `MessageInput`（及画布命令栏 `CanvasCommandBar`）的「后台云端」开关下派发任务（`dispatchHandoffJob`），随即落一张卡（派发中 / 运行中 / 已完成 / 失败，按时间戳并入时间线、随对话重开重放）；完成后卡内「查看并应用」就地展开**内联简化评审**——默认全部接受（干净变更直接应用），只把真冲突逐个列出选「云端覆盖 / 保留本地」、可展开预览，应用回本地（写回前重读本地哈希、服务端按快照哈希权威复核冲突）。三段式后端契约（snapshot / 云作业 / diff 三方判定回写，`HandoffJob` 专表）不变，仅前端入口从侧栏孤岛下沉进对话。→ 见代码 `components/chat/BackgroundTaskCard.tsx`、`components/chat/BackgroundTaskReview.tsx`、`stores/backgroundTasks.ts`、`components/chat/MessageInput.tsx`、`components/graph/CanvasCommandBar.tsx`（画布同款开关）、`components/graph/CanvasDecisionPanel.tsx`（画布模式承载卡片）。

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
| 节点高亮 | 内嵌图与全屏图**同源派生自**面板当前激活 run tab（切/关 tab、切到「工作区」tab、关面板自动跟随）——全屏图把该 run 详情就地开在画布右侧（`GraphDetailPanel`，复用同一 `sidePanel` store） | 一面一个高亮源，**否决**反向 `selectRun` 跨 store 对账 |

**run-detail 区段构成**：头部（角色 / 状态 / 用时）、任务、**收到的上下文**（该 run 实际被喂进的结构化上下文：原始请求 / 团队位置 / 前置结果〔含来源·保真度·是否截断〕/ 工作区 / 任务…，由 `run_context` 事件折入；守「单一源：用户看到的 == LLM 吃到的」，每块一张可展开卡片，分级展示随「用量明细」开关；详见 [`../03-AI核心/上下文传递可视化.md`](/docs/03-AI核心/上下文传递可视化.md)）、错误（失败强制展开）、**思考过程**（worker 思考全文，`run_reasoning_delta` 流式；流式时自动展开、完成自动收起）、**正在生成**（worker 拼装工具调用参数时的实时行「{工具} · N 字」，`run_tool_progress`；仅运行中且参数流式中出现，参数拼完即让位给下方工具调用行）、输出、工具调用、**协作关系**（`dependsOn` 依赖 + 后续）、**委派关系**（上级 + 子任务树，详见下段）、**资源消耗**（power 粒度全量 token + ¥ 明细，外加模型档位·思考强度；默认折叠，开「用量明细」时展开，¥ 总额不受该开关影响。档位·思考强度原为独立「模型与推理」区段，因属低频信息已降级并入此处折叠明细）。**独立 `reasoning` Tab 已否决**——思考全文本质 per-run，归 run-detail「思考过程」区段而非全局 Tab。→ 见代码 `RunDetailBody.tsx`。

**委派展示统一**：单一可视化（`GraphView` 一张图同表委派树与 `depends_on` 依赖）+ 单一数据模型（`AgentRun`：编排步骤与委派子 Agent 共用同一节点类型）+ `run_*` 事件族（前端不拼接两路流）。**被否决**：前端按 N 隐藏其一（状态仍分叉）；保留双协议只在前端合并（双写漂移）。

**run-detail「委派关系」区段**（阶段2 嵌套委派）：worker 详情在「协作关系」（`dependsOn` 上游 依赖 / 下游 后续，横向同波次）之外另设「委派关系」区段——「上级」是委派它的 captain worker（仅当父 run 是本回合图上的真实节点才显；顶层 worker 的父是 CEO captain、图上无节点，故为空），「子任务」按 `parentRunId` 递归缩进成树、点行下钻该子 run。两者**并列而非混淆**：DAG 边横向（同波次依赖），委派边纵向（嵌套层级）。→ 见代码 `RunDetailBody.tsx`。

**聊天紧凑化原则**：inline 只做信号展示（思考折叠条/状态条/内嵌协作图）；面板承担完整详情（思考全文/run 全文 + 工具 IO + 用量）；失败/运行中强制展开（错误绝不藏）；协作图内嵌于回合（非面板 Tab），大图 / 回放进临时全屏。

---

## 十一、Agent 可发现性 ✅ 已确定

可发现性是 Agent 的固有属性，单独成轴，不从「被哪个团队引用」反推。三态：`public`（上架，进发现/搜索，并入 CEO **智能路由**的可用人才池）、`unlisted`（后台构件，不进发现面但按 id 可直达）、`private`（仅创作者可见）。**可发现 ≠ 用户手选**：可发现只是把 agent 喂进 CEO 的人才池由智能路由自动组团，**不给用户开「选择器」菜单**（手选 = 替代 CEO 调度、制造双决策逻辑，已否决）。

**设计原则**：单一谓词（一处过滤 `visibility=public` 覆盖全部发现入口）；`is_featured` 解耦（回归「编辑精选」本职，与可见性正交）；缺省 public（避免误隐藏）；组件型默认 unlisted（团队成员/captain/竞技场角色）。

**被否决**：把辩论/对抗角色拆成**给用户手选的独立实体**——违背 Multi-Agent First；辩论由 CEO 自动调度、主持人驱动（§四），主持人 / 辩手不进发现面、不给用户手选，无独立 Arena 实体或槽位。

---

## 十二、工具箱（卡片网格）

> **已落地**：工具箱页（`/toolbox`）为卡片网格 IA（→ 见代码 `pages/ToolboxPage.tsx`）；「AI 能力」子页 = **能力图鉴**（工具 + 技能 + AI 工作准则一页纵览，`CapabilityCatalog`，→ 见代码 `pages/toolbox/AiToolsPage.tsx`）。本节为关键决策；工具/产物模型见 [`工具与能力系统.md` §8.4](/docs/03-AI核心/工具与能力系统.md)。

工具箱页用**卡片网格**（`auto-fill minmax(260px,1fr)`，磁贴：图标居左 + 标题/副文 + 右侧 `›` 或「即将上线」徽章），按三组**轻量小标题（非 Tab）**排布：

- **创作工具**：文档 / 思维导图 / 多维表格 / 画布 / 幻灯片 / 可运行产物 / 流程图 / 表单——各为一种产物类型，点击进「该类型产物列表 + 新建」。
- **能力**：AI 能力（点开 = 能力图鉴 `/toolbox/ai-tools`：工具（CEO/队员可用性 + 调用参数）+ 技能（summary + 完整正文）+ AI 工作准则（系统提示词模板））/ 集成 · 连接器（MCP & 第三方）/ 工作流（编排工具 + Agent）。
- **了解平台**：产品手册（`/toolbox/manual`，沉浸式全屏、左侧目录 + 阅读列；唯一入口，四组——开始 / 核心功能 / 运行机制 / 进阶 & 帮助；「运行机制」组即原团队运行机制并入，详见 §五）。

**关键决策**：分组用小标题而非 Tab——一屏纵览全部能力、零层级切换；**「了解平台」与「能力」分立**——产品手册是说明 / 透明页、既非创作工具也非「可被编排进团队」的能力，单独成组以免污染「能力」组语义（**否决**塞进「能力」组）。**了解平台收敛为单一入口「产品手册」**——原独立「团队运行机制」页（`/toolbox/mechanism`）已并入产品手册「运行机制」组（**否决**两张并列卡片：受众都是「想看懂平台」，并列徒增入口噪音；机制内容随手册一站可达）。**现状**：「AI 能力」与「产品手册」（含运行机制）已落地，其余创作工具、集成 · 连接器、工作流为占位（「即将上线」）；各创作工具的编辑器与「产物列表 + 新建」流程归 `file` / `table` 体系，多为 Post-MVP（见 [`工具与能力系统.md` §8.4](/docs/03-AI核心/工具与能力系统.md)）。

**关键决策 · 能力透明分层公开**：AI 的工具 / 技能 / 提示词**对所有人公开**，分三层渐进披露，「默认结构化、一键见原文」——L1 能力图鉴（静态全景：工具含 CEO/队员可用性 + 调用参数、技能含完整正文、AI 工作准则展示系统提示词模板，数据出自 `/v1/capabilities`）；L2 运行过程（`consult_skill` 在过程时间线/队员详情里渲染为「查阅能力」卡，见 §一B）；L3 本回合提示词（每条 AI 回复 hover → 「提示词」打开**逐字**系统提示词弹层，出自 `turn_journal` 的 `turn_started`）。**否决**「把原文当竞争资产藏起来 / 仅对开发者开放」——对齐产品「真实协作、可被看懂」的心智；原文展示用弹层/折叠承载，不污染默认结构化视图。注意：这与 §五「产品手册页否决页内开发者细节开关」不冲突——后者只约束**手册页**保持纯用户向，原文透明落在能力图鉴与消息两处独立界面。

---

## 十三、质量档设置页（内测已退役）

内测下线：质量档设置页、对话输入框 `ModeSelector`、前端词表/缓存整片删除。→ 见 [`编排器与CEO主Agent.md` §2.1](/docs/03-AI核心/编排器与CEO主Agent.md)。

---

## 十四、全局搜索与命令面板（现状）

`Ctrl/Cmd+K` 打开的命令面板 = **Tier 1** 全局关键词搜索（对话 / 消息 / 文件夹）+ **Tier 2** 命令导航（新建对话 / 跳转页面 / 切换主题 / 切换侧栏等）✅ 已落地。

- **空查询**：最近对话置顶 + 命令列表。
- **有查询**：300ms 防抖调后端搜索；消息命中带 snippet 高亮；文件夹跳转对话管理页并闪烁选中。
- **跳转**：消息命中走 load-around（命中必达，见技术文档 §9.7）。

技术契约见 [`前端技术与架构.md` §9.8](/docs/04-前端/前端技术与架构.md)。**Tier 3** 语义搜索（pgvector）⏳ 未落地，见 [`07-规划/远期规划.md` §三](/docs/07-规划/远期规划.md)。

---

## 十五、待定事项

| 议题 | 说明 |
|------|------|
| 移动端适配 | 图视图在手机端如何简化 |
| 多任务同时进行 | 多个任务并行时图视图如何呈现 |
| 历史任务回放 | 图视图内帧流回放已落地（`Timeline`）；跨会话回放完整历史任务待定 |
| 无障碍访问 | 图视图的键盘导航和屏幕阅读器支持 |
| 离线态 UX | 已连接但目录不可达时的降级展示 |
