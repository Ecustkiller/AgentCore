# 前端 UX 设计

> **状态**：已确定方向
>
> 本文记录**已落地现状 + 关键决策（含被否决方案）**。未落地的目标态 UI 规格（信息层次模型 + `checkpoint_after` / Arena / 图增量节点，均后端先行）见 [`07-规划/前端UX目标态.md`](/docs/07-规划/前端UX目标态.md)。

---

## 核心设计理念

用户心智模型是「管理一个 Agent 团队」，UI 是用户感知这一心智模型的唯一窗口。设计需在「零门槛入门」和「差异化体验」之间取得平衡。

---

## 一、全局布局与团队展示

全局采用 **侧栏 + 页面级自定义布局**（详见 [`前端技术与架构.md`](/docs/04-前端/前端技术与架构.md) §五）。核心对话页为单栏聊天区：

```
/conversations/:id（单栏聊天区）
  消息流（多 Agent 回合：助手消息内嵌 InlineTeamGraph）+ ApprovalPrompt（工具审批）
  └ MessageInput（底部固定）
内嵌图右上「最大化」→ 临时全屏（TeamGraphFullscreen，含回放 Timeline + 大画布）
点图节点 → 右侧 SidePanel 新开该 run 的详情 tab（被动下钻）；面板是一条扁平 tab 栏——固定首位「工作区」tab（文件/快照/交接）+ 按需的 run 详情 tab。右上「侧面板」开关 / Ctrl+I → 显隐（冷启动落「工作区」tab），Ctrl+J → 直达「工作区」tab
```

**侧栏对话区（IA）**：侧栏只列**最近若干对话**（扁平、按时间，当前对话恒置顶可见）+ 底部「查看全部对话」入口；完整列表、文件夹分组、文件夹增删改与「按文件夹筛选 / 页内搜索」统一收敛到独立的**对话管理页** `/conversations`（canvas 档：左侧文件夹筛选 + 右侧对话列表，点对话进 `/conversations/:id`）。**决策**：侧栏保持轻量、只承载高频的「最近 + 新建对话」，低频的归档/整理移交专门页面，避免侧栏被长列表与文件夹树占满；新建文件夹入口随之从侧栏移到管理页。→ 见代码 `components/sidebar/RecentConversations.tsx`、`pages/ConversationsPage.tsx`。

**团队展示统一到「内嵌协作图」**：多 Agent 回合的助手消息上方内嵌一张协作图（`InlineTeamGraph`），它是该回合的**主团队界面**——图顶状态条折进了原任务卡片的职责（状态 · N agents · M/M · 用时 · ¥合计 + 救火行），节点 face 只显角色 + 任务/输出 + 用时/工具（¥ / token 归 run 详情，§7.3B），点节点把详情下钻到右侧被动面板，右上「最大化」临时进全屏看大图/回放。单 Agent 回合不出图（纯气泡，零噪音）。原「对话内卡片 + 右侧常驻面板 + 全屏 overlay」三个抢戏的面已收成一面，决策与迁移源见 [`前端技术与架构.md` §9.2–9.6](/docs/04-前端/前端技术与架构.md)。

| 形态 | 何时 | 职责 |
|------|------|------|
| 内嵌协作图（主） | 多 Agent 回合，随消息常驻、刷新可回看 | 状态条（进度/成本/救火）+ DAG + 节点用时/工具 |
| 临时全屏（按需） | 点内嵌图「最大化」 | 大画布 + 回放 Timeline + 节点详情 |
| 右侧 SidePanel（被动） | 点图节点才新开 run tab | 一条扁平 tab 栏：固定「工作区」tab + 按需 run 详情 tab（单 run 全文，可多 run 并存对比） |

> 信息分层：单 Agent 回合 = 纯气泡（Layer 0 输出）；多 Agent 回合 = 内嵌图（Layer 1–3 状态/进度/协作）+ 点节点进面板看 run 全文（Layer 4）。完整信息层级模型见 [目标态 §一](/docs/07-规划/前端UX目标态.md)。

> 页面宽度由 `PageContainer`（content 896px / canvas 1200px，统一 `px-6 py-8`）约束，各页按档位接入（→ 见代码 `components/layout/PageContainer.tsx`，完整规范见 `.cursor/rules/desktop-layout.mdc`）；对话页 / 文件页自有布局除外。

---

## 二、聊天视图（现状）

标准对话流界面（类似 ChatGPT / Cursor），嵌入 Multi-Agent 特有元素：

| 元素 | 作用 | 何时出现 |
|------|------|----------|
| 内嵌协作图 | 团队 DAG + 状态条（进度/成本/救火） | 多 Agent 回合自动内嵌于助手消息 |
| Agent 标签 | 标识当前输出来自哪个 Agent | 流式输出时 |
| 检查点卡片 | CEO 暂停征询用户拍板（继续/调整/停止） | CEO 调 `ask_user` 时（含单 Agent 回合）|

简单任务（单 Agent）时不出图，体验同 ChatGPT。

**已落地**：`MessageInput` 支持 Textarea 自动增高、`@` 引用文件 / 附件按钮浏览（`MentionMenu` + 文件索引）、拖拽文件入框成附件（OS 文件直读、超 256KB 截断、二进制/图片拒收、文件夹引导走 `@`）、附件 chips、字数统计、弹窗键盘导航（↑↓/Enter/Tab/Esc）；`MessageBubble` 富文本 Markdown（代码高亮 `rehypeHighlight`、KaTeX 数学、GFM 表格、`[n]` 来源引用 chip + `SourceCards`）、思考过程折叠条（流式时自动展开、结束自动收起）、hover 操作栏（复制 / 编辑重发 / 重新生成）、hover 时间戳（`formatMessageTime`：相对时间，title 悬浮显示完整时刻）；快捷键 `Ctrl/Cmd+K` 全局搜索（`CommandPalette`，跨对话 / 消息 / 文件夹分组检索 + 命中定位，详见 §十四）、`Ctrl/Cmd+N` 新建对话、`Ctrl/Cmd+\` / `Ctrl/Cmd+B` 折叠/展开左侧栏、`Ctrl/Cmd+I` 显隐对话侧面板（`SidePanel`，记忆激活 tab、冷启动落「工作区」tab）、`Ctrl/Cmd+J` 直达「工作区」tab、Enter 发送、Ctrl/Cmd+Enter 换行、内嵌图临时全屏内 Esc 返回（→ 见代码 `components/layout/AppShell.tsx`、`components/chat/`、`components/layout/CommandPalette.tsx`）。输入框富功能已审定：Slash 命令暂缓（与 `CommandPalette`/自然语言重复；合法内核「自定义命令 = 可复用 prompt 模板」归 §十二 工作流 / 产物体系 Post-MVP）、Agent/Team 选择器已否决（手选 agent = 替代 CEO 调度，可发现 agent 改走智能路由见 §十一）、产物 Pill 退役（产物经 `@引用`/`WorkspaceModeBar`/产物卡三方分摊）；气泡内工具卡、文件夹落点 pill 已退役（工具详情走面板、落点走 `WorkspaceModeBar`）。

消息载入采用游标窗口：进对话载入最新一窗，上 / 下无限滚动加载更早 / 更新回合，搜索命中可定位到任意历史消息（load-around，命中必达）——契约见技术文档 §9.7。

---

## 三、内嵌协作图与状态条（现状）

多 Agent 回合的团队界面是内嵌进助手消息的协作图（`InlineTeamGraph`，→ 见代码 `components/chat/InlineTeamGraph.tsx`）：图顶一条**状态条**按 `execution.status` 分四态渲染，下方是可折叠的协作图（`GraphView` 内嵌形态），右上「最大化」进临时全屏。状态条吃下了原任务卡片的全部职责（AgentCore 聊天界面与普通对话 AI 的核心视觉差异点）：

- **执行中**（`RunningStrip`）：转圈 + 任务摘要 + 进度 `completed/total` + 进度条；尾部控件（停止 / 折叠图 / 全屏）。Agent 状态/工具/输出在下方图节点上呈现。
- **已完成**（`CompletedStrip`）：一行战绩「团队完成 · N 个 Agent · M/M 子任务 · 用时 · ¥合计」（用时取帧流挂钟跨度 `elapsedMs`，¥ 取 `message_end` 回合合计 §7.3A）。**部分失败**（CEO 完成但有 worker 失败）额外显示琥珀色「N 个子任务失败」横幅 + 救火行。
- **已停止**（`status=cancelled`）：同战绩形态，「已停止」标题，在跑节点冻结为 cancelled（不再转圈），救火行显示「已花 ¥」。
- **失败**（整轮崩溃，`FailureStrip`）：高亮失败 Agent / run + `run_failed` 错误原因 + 救火行。

救火行（`RecoveryActions`）由失败条、部分失败的已完成条、已停止条共用——重试（从最后一条用户消息整轮重跑）/ 调整指令（内联编辑后重发）/ 放弃（清空该回合执行槽）。状态条尾部为一级图标按钮：执行中给「停止」、已完成/已停止给「回放」（进全屏自动播放时间轴），外加常驻的折叠 / 全屏；不设 `[···]` 菜单——整轮重跑统一交给消息级「重新生成」与救火行「重试」（原菜单的「重新规划」是同一动作的重复入口、运行态还失效，与裸复制「任务 ID」一并移除）。内嵌图块在 `run_plan` 首次挂载时播放一次入场动画（`animate-task-card-enter`，遵循 `prefers-reduced-motion`，见 `styles/globals.css`）。

**出现时机规则**（核心决策）：

| 场景 | 行为 |
|------|------|
| 简单任务（CEO 直接回答，无 plan） | **不出图**，直接流式输出，体验同 ChatGPT |
| 多 Agent 任务（CEO 调用 `delegate`） | `run_plan` 到达时**自动内嵌**于助手消息上方 |
| 任务完成 | 状态条**收缩**为一行战绩摘要 |
| 用户停止任务 | 状态条转「已停止」，在跑节点冻结，提供重试 |
| 用户发新消息 / 刷新 | 每条回答各持自己的执行槽（按 `messageId` §9.3），历史图保留，刷新后从 `message.runs` 回放 |

**为何无「规划中」态**（决策）：CEO + `delegate` 架构下 `run_plan` 同步到达，无独立规划空窗；「系统在思考」由 CEO reasoning 气泡覆盖；`tool_use_start(delegate)` 前无法预知是否组团，故状态条不设「规划中」态。→ 见代码 `delegate.py`、`engine.py`。

**检查点卡片（已落地）**：CEO 执行中途遇到「自己无法独自定夺、且选错代价高」的关键岔路时，调内置工具 `ask_user` 暂停本回合并请用户拍板——区别于状态条里的团队进度，它是**会话流内、挂在该助手消息下**的独立卡片（琥珀 `warning` 令牌），刷新后随消息回放。卡片给「继续 / 调整 / 停止」三动作（CEO 可附 `options` 具体选项 + 自由文本调整方向）：**继续**＝按 CEO 方向推进，**调整**＝带用户 steer 续跑，**停止**＝优雅结束本回合（CEO 收尾语随之流式落库）。用户答复经 `POST …/interactions/{id}`（kind=ask_user，§18.2 统一挂起原语）回流进 CEO 的 ReAct 循环；超时由引擎落 `timeout`、交回 CEO 自行稳妥收尾。卡片仅在「该消息仍在流式（即本回合挂起中）」时可操作，历史/已结束回合渲染为只读记录。→ 见代码 `components/chat/CheckpointCard.tsx`、`services/checkpoint.ts`、`stores/conversation.ts`（`checkpointsFromEvents` / `addCheckpoint` / `settleCheckpoint`）、后端 `tools/builtin/ask_user.py`。SSE 契约（`checkpoint_required` / `checkpoint_resolved`）见 [执行引擎架构设计.md §SSE 事件](/docs/03-AI核心/执行引擎架构设计.md)。

> **勿与两个近邻混淆**：① **工具审批**（`approval_required`，GRANTABLE 工具授权）是另一套、渲染在输入框上方而非消息内；② **DAG `checkpoint_after`**（按 step 结构化挂起）仍为 ⏳ Phase 2，与此处 CEO 主动 `ask_user` 是不同机制。`TeamPreviewCard` 团队预审 gate（执行前预览团队 / plan_review）随 preflight 审计一并 ⏳ Phase 2，见 [`编排器与CEO主Agent.md` §四](/docs/03-AI核心/编排器与CEO主Agent.md)。

---

## 四、辩论/审查范式（现状）

辩论/审查是 MVP Day1 范式（见 [Agent协作模式.md §一](/docs/03-AI核心/Agent协作模式.md)），与普通并行分工**同形执行、差异呈现**。**核心决策（形状是数据不是模式）**：辩论的执行就是 `A(pro) ∥ B(con) → CEO 综合` 的普通并行 DAG，SSE 与普通多 Agent 完全一致；差异化呈现靠 CEO 在 `delegate` 给对立子任务打可选展示标记 `stance`（`pro`/`con`）/ `group`（同组配对键），**调度器/执行器忽略**、`run_plan` 透传，前端据此识别辩论并差异化渲染。**否决**辩论专用执行路径 / `plan_type`（架构已收敛，重新引入是倒退）。→ 见代码 `tools/builtin/delegate.py`、`runtime/runs/builder.py`、`stores/execution.ts`（`isDebate` / `debateSides` / `debateGroups`）。

差异化呈现四处（仅辩论回合触发，普通并行批次零变化）：

| 处 | 现状 |
|----|------|
| 范式标题 | 内嵌图状态条显「辩论」pill、完成态作「辩论完成」（普通为「团队完成」）——`InlineTeamGraph` |
| 节点 badge | 对立节点显「正方/反方」徽章（`info` 令牌，与 6 态状态色解耦）——`AgentNode` |
| 图分列对置 | 正/反节点按 `stance` 排序 + ELK `considerModelOrder`，分两带对置、汇聚到 CEO 收尾节点——`GraphView` / `lib/elk-layout.ts` |
| 左右并排对比 | 图卡下方一张「辩论对比」卡片：按 `group` 分组，每组 `正方 \| 反方` 两栏并排（896px 阅读列）渲染 worker 产出，点角色行下钻右侧详情看全文——`DebateCompare` |

**辩论收尾复用现有检查点**：CEO 跑完对立 run 后调 `ask_user(options=["采纳正方","采纳反方","都要","补充论证"])`，复用 §三 `ask_user` 检查点卡片（CEO prompt 教「对立任务打标」与「`ask_user` 收尾」，见 `runtime/prompt.py`），无新检查点类型。

**真·结构化辩论（Arena）仍属 ⏳ Phase 2**（阶段轮转 / 独立 `arena` 节点 / 独立 SSE / 状态机，见 [`Agent协作模式.md` §7.4](/docs/03-AI核心/Agent协作模式.md) + [目标态 §三](/docs/07-规划/前端UX目标态.md)）；本节展示提示是其落地前的轻量 MVP 差异化。

---

## 五、图视图（现状）

内嵌于多 Agent 回合的助手消息（`InlineTeamGraph` 里 `GraphView` 的 `embedded` 形态，为**静态预览**：禁滚轮/捏合/双击/拖拽缩放且 `preventScrolling=false`，鼠标滑过时滚动的是对话而非缩放画布，缩放/平移探索全交给全屏），点状态条右上「最大化」进临时全屏（`TeamGraphFullscreen`）。**内嵌画布按 fit-to-width 定高**：宽度撑满消息列、缩放只缩不放（`zoom = min(1, 列宽/图宽)`，列宽以 `ResizeObserver` 实测）使节点尺寸跨消息一致，盒高跟 ELK 包围盒在该缩放下的真实投影走并 clamp（180–520px），故串行链矮、并行扇高——取代早期「按 run 数估算」会过早顶满、且无视拓扑、还因 `fitView` 两轴缩放致节点忽大忽小的旧策略；超高时顶对齐 + 底部渐隐示意「还有更多」，看全图进全屏。为此 `computeLayout` 随位置一并返回包围盒。`GraphView` 将 run 映射为 `agent` 节点 + 两端的端点节点（用户输入 / synthesis 收尾，`EndpointNode`），ELK 布局两种（默认左右流 / 树形——默认取左右流契合横屏、内嵌↔全屏方向一致，`lib/elk-layout.ts`；布局算法偏好持久化于 `stores/graph.ts`，位置/边为每图本地态，一页多张内嵌图互不覆盖）；节点 face 收敛为「角色 → 在干什么 → 用时/工具」三层：6 态色环 + 图标承载状态（**不再用文字重复**，普通队员只剩单行角色名）、模型档 / 深度思考徽章、中行（**运行中** = 流式输出预览带光标 / **其余态** = 任务一句话 `run.task`，取代旧的「取输出末尾 80 字、对代码/文件纯属乱码」的 tailText 预览）、脚注用时 + 工具数；**¥ / token 不上节点 face、归右侧 run 详情面板**（§7.3B）；`StepEdge` 运行中边以 SVG 粒子流（`animateMotion`）动画；节点状态过渡为纯 CSS：按 plan 顺序错峰入场（`graph-node-enter`）、run 进入终态时一次性完成/失败闪烁（`graph-node-flash` + `useTerminalFlash`）、切换布局时位移 morph（`.react-flow__node` transform 过渡），均遵循 `prefers-reduced-motion`。**run 详情单一出口**：内嵌与全屏点节点都下钻到右侧 `SidePanel` 新开的 run 详情 tab（全屏点完即退出，露出身后对话）；临时全屏额外提供画布右上布局切换工具栏（左右流 / 树形 + 「适应画布」按钮；**已移除 React Flow 自带 +/− 缩放控制条**，与工具栏 fit / `F` / 右键菜单「适应画布」三重重复）+ 帧流时间轴回放（`Timeline`：播放 / 拖动 / 回到实时，亦可从完成 / 已停止态状态条「回放」直接进全屏自动播放）+ 节点/画布右键菜单（查看详情 / 居中此节点 / 适应画布，复用 `sidebar/ContextMenu`）+ `F` 适应画布 + Esc 退出（→ 见代码 `components/graph/`）。

**嵌套子团队父子分组**（阶段2 嵌套委派）：某 worker 经 `can_delegate` 再向下带一层小队时，其子 worker **不接入**「用户输入 / synthesis」端点 bookend（只有顶层 worker 参与端点接线），而由 captain worker 画一条**虚线委派边**指向每个子 worker（`StepEdge` 按 `kind:"delegate"` 渲染虚线，区别于实线 DAG 依赖与运行中粒子流），子 worker 节点带「子任务」徽章（`AgentNode`）。分组键取 `run_plan` 预声明的 `parent_run_id`，故布局在 `run_started` 之前即成组、分层布局把子 worker 紧贴其 captain 聚拢。**端点钉层**：CEO 汇聚点端点钉在 ELK 末层、用户输入端点钉首层（`layerConstraint` LAST_SEPARATE / FIRST_SEPARATE）——否则叶子子 worker 与汇聚点同跳数（都距父 worker 一跳、下游皆空），会被 ELK 拉到**同一列**，汇聚点本应排在子团队之后；钉层后恒为「用户输入 → 团队波次 → 子团队 → CEO 汇聚点」，对扁平/辩论/多波 DAG 是 no-op（汇聚点本就在末层）。**子团队下沉**：钉层后父 worker 那条**实线**「父→汇聚点」边仍会横穿夹在中间层的子 worker（与父同跳被 ELK 摆到同一行、读成假主干链，且边优先级无法消除），故再加一道**跨轴后处理**把整条子团队带下沉到该主干线**之下**——子团队遂以虚线支线清楚挂在父 worker 下、主干线不被遮挡（仅动交叉轴、不改层与列；包围盒随之在交叉轴增高）。**多父整块堆叠**：同一波次多个父各自带子队时，逐父独立下沉会令两支子队（乃至上方父的子队与下方父本身）落到同一交叉带相互压盖；故下沉按交叉轴阅读序把每个「父 + 其子树」当一个**整块依次堆叠**、维护 floor——必要时把靠下的父连同整块再下推让开上一块，端点随后按父的**最终**跨度重新居中（故下沉须在端点居中**之前**跑；单父退化为原行为、零回归）。**否决容器嵌套盒**：父子关系用「委派边 + 徽章 + 下沉支线」表达而非 ELK compound 容器——下沉后处理已用单测覆盖「2 级嵌套 / 同层双父」且证明开销低，compound 的重构布局风险与其收益不成正比。→ 见代码 `GraphView.tsx`、`lib/elk-layout.ts`（`LayoutBookends` / `dropSubTeamsBelowParent`）、单测 `lib/__tests__/elk-layout.test.ts`。

**可达性与多选**：节点 `role=button` + `tabIndex` 键盘 focus + Enter/Space 激活 + `aria-label` 播报角色/状态/模型/Token/成本/用时/工具；支持多选（修饰键加选 / 框选，`selected` 与面板下钻高亮共用 outline）。**动画 / 布局选型理由**：状态过渡用纯 CSS（**否决 Framer Motion**——零依赖、与 React Flow 定位 transform 无冲突）；ELK 仅留左右流 / 树形（径向 / 力导向曾实现、小团队下无价值已移除）；右键菜单复用 `sidebar/ContextMenu`（无需 Radix）。

> 仍在目标态的增量（arena / 检查点节点，随后端落地）见 [目标态 §四](/docs/07-规划/前端UX目标态.md)。**已否决·工具点节点**：每个工具调用单独成图节点 = 与「inline 只做信号、面板承担完整详情」+ §八 ≤50 节点性能约束冲突（一个调研 agent 调 10 次 `web_search` 即 +10 节点）；工具已被 agent 节点「工具数」+ `SidePanel` run 详情工具 IO 区段覆盖，无需独立节点。

> **团队运行机制页（开发 / AI 自查）**：`更多 → 团队运行机制`（`/more/mechanism`）用**真实** `AgentNode`/`EndpointNode`/`StepEdge` + 真实 ELK 布局，把上述节点 / 状态色环 / 连线（实线依赖 · 虚线委派 · 点线修订）/ 徽章逐个标注为机制含义，并叠加运行时全景（Prepare→Execute→Finalize）、协作回合主线、SSE 事件族、前端执行态分片，每处配代码指针——是协作图机制的**可视化真相源**，与 `docs/03-AI核心`（文字描述）互补。→ 见代码 `pages/more/TeamMechanism.tsx`。

---

## 六、视图切换（现状）

| 行为 | 现状 |
|------|------|
| 看团队 | 多 Agent 回合的图已内嵌在助手消息里，无需切换；状态条可折叠收起图 |
| 进临时全屏 | 内嵌图右上「最大化」→ `TeamGraphFullscreen`（portal 到 `body`，含回放 Timeline + 大画布） |
| 退出全屏 | 左上角 [← 返回] / Esc；退出即回到对话页原状态 |
| 看单 run 详情 | 点图节点 → 右侧 `SidePanel` 新开该 run 的详情 tab（被动下钻，可多 run 并存对比） |
| 看工作区文件 | 聊天右上「侧面板」开关 / `Ctrl/Cmd+I`（冷启动落「工作区」）或 `Ctrl/Cmd+J`（直达） → `SidePanel`「工作区」tab（固定首位：文件/快照/交接） |
| 数据同步 | 各回合按 `messageId` 投影自己的执行槽（`projectExecution`），实时与回放走同一 fold（§9.3 / §9.4） |

---

## 七、设计原则总结

| 原则 | 说明 |
|------|------|
| 零门槛入门 | 新用户看到的就是普通聊天，不会被面板或图吓走 |
| 渐进式揭示差异 | 单 Agent 纯气泡 → 多 Agent 内嵌图 → 点节点进面板下钻 → 「最大化」进临时全屏 |
| 简单任务零噪音 | 单 Agent 时不出图，体验同 ChatGPT |
| 只在关键点求交互 | 检查点和异常时才需要用户操作 |
| 临时全屏无损 | 进出临时全屏看完返回，对话流状态不变 |
| 口碑传播点 | 图视图的截图非常适合社交媒体传播 |
| 页面自治 | 各页面自定义布局，全局壳不强制面板结构 |

---

## 八、图视图技术选型

**方案：React Flow 为基座 + 自定义动画层**（已引入 React Flow + ELK.js；布局见 `lib/elk-layout.ts`）。

**选型理由**：与 React 技术栈原生契合（自定义节点即普通 React 组件）；图视图是补充视图（非主界面），不值得自研；场景 ≤50 节点 React Flow 足够；粒子动画可经自定义边增量实现。

**被否决**：
- **D3**——与 React DOM 模型冲突；节点内容复杂（进度条/多行/状态灯）SVG 手绘极痛苦；丢失 React 组件复用与状态管理。
- **自研画布**——图视图非核心壁垒（编排器才是），自研需 1–2 个月，资源错配；50 节点不需要 Canvas/WebGL 极限性能。

**性能约束**：节点 ≤50、≥60fps、首屏 <200ms、布局计算 <100ms。

---

## 九、文件交互设计 ✅ 已确定

> 部分落地——`FilesPage` + `fs-service` 支持浏览、预览、添加根目录（→ 见代码 `pages/FilesPage.tsx`、`main/fs-service.ts`）。本地文件系统底层设计见 [`前端技术与架构.md`](/docs/04-前端/前端技术与架构.md) §八；本节为 UX 层面决策。

**设计原则**：一棵以本地授权目录为根的树。**被否决**：「云端/本地两平级源」上下分段——心智割裂 + 主次写死。

| 交互 | 行为 |
|------|------|
| 添加文件夹 | 选本地目录 = 立即成为一个项目（建云端身份一步到位） |
| 展开目录 | 懒读子项 + 启动 watch；折叠即停止 watch |
| 内联改名 | 就地 input，回车/blur 提交，Esc 取消 |
| 拖拽移动 | 落点校验（非原父/非自身子树） |
| 右键菜单 | 根节点与普通节点分开（根有「设为项目」「连接/断开」） |

**审批 UX（写操作）**：只读时尝试写引导开启；可写时写前弹审批（可「本轮内都允许」批量放行，依赖 §三工具审批三态 `grantable` 级别，避免 N 次写 = N 次弹窗）。

**对话落点表达**：已选文件夹→输入框「文件夹」pill 显示项目名；未选但 Agent 自动落点→pill 标「自动」并提供「固定为文件夹」一键升级；无桌面→不挂写工具，需显式出口。

**隐私承诺**：默认不留存（未备份内容不进云）；在途可用（读文件时正文临时发给模型）；备份/分享 = 显式上传（不自动同步，操作前明示）。

---

## 十、详情面板与委派展示 ✅ 已确定

> **实现现状**：对话右侧收敛为**单一侧面板** `SidePanel`，建模为**一条扁平 tab 栏**（外壳：拖拽 resize + tab 栏 + 关闭）——固定首位「工作区」home tab（永不关闭：`WorkspaceModeBar` 云/本地 + 文件 / 快照 / 交接子页）+ 按需的 run-detail tab（点内嵌协作图节点把该 run 钉为 tab，可并存对比，上限 6；进度/协作图已折进内嵌图，不再设 `task-progress`/`task-graph` tab）。取代原先**并排会挤爆聊天**的两个独立右坞（详情面板 + 工作区面板），并**取消早期「详情 / 工作区」段控互斥模式**——工作区本身即常驻首 tab、run 与它同栏并列，故面板永不出现空详情占位。工作区 body 首次激活才懒挂载、之后 keep-alive 不卸载（文件不重拉）。面板共享一份 `open` / `width`（280–560px）/ `section`（均持久化），run tab 集为会话级、按 `messageId` 投影对应回合执行槽。协作图节点高亮派生自当前激活 tab：激活某 run tab→高亮其节点，激活「工作区」tab（不在 run tab 集）→无高亮（守「一面一个高亮源」）；关 run tab 回退到相邻 run tab、否则落回「工作区」tab（面板不因此关闭）。打开入口：点图节点→新开 run tab、右上「侧面板」开关（`PanelRight` 图标，常驻、开启时高亮）/ `Ctrl/Cmd+I`→显隐（记忆激活 tab、**冷启动落「工作区」tab**，故手动打开即落在项目文件）、`Ctrl/Cmd+J`→直达「工作区」tab；`Ctrl/Cmd+B` 留给左侧栏折叠避免双触发。（→ 见代码 `stores/sidePanel.ts`、`components/layout/SidePanel.tsx`、`components/chat/detail/RunDetailBody.tsx`、`components/workspace/WorkspacePanel.tsx`（`WorkspaceMode`）、[`前端技术与架构.md` §9.2 / §9.4](/docs/04-前端/前端技术与架构.md)）。本节为关键决策。

聊天右侧详情面板 = Agent 执行的「点开看详情」查看器：正文气泡保持简报（思考折叠条 + 内嵌协作图信号），点图节点后右侧推入该 run 完整详情。**核心价值**：Multi-Agent 一次交互信息量大，正文保持简报、细节按需点开。

**关键行为决策**：

| 决策 | 取值 | 理由 |
|---|---|---|
| Tab 管理 | 动态打开/关闭（非固定 Tab 栏） | 用户只看关心的 |
| 标签上限 | 6，超出淘汰最旧 | 防无限堆积 |
| 持久化 | `open` + `width` + `section`；run tab 集会话级 | 面板形态持久，run tab 是临时工作态 |
| 多开 | 多个 `run-detail` 可并存对比 | **否决**每次覆盖 |
| 数据获取 | Tab 只存引用（指针），详情从 run 树现取 | 单一数据源 |
| 下钻导航 | 子任务点击开新 Tab，无限层级 | 各 Tab 独立 |
| 打开方式 | 点内嵌图节点下钻该 run（无自动进度 tab） | 按需、零噪音 |
| 节点高亮 | 内嵌图高亮**派生自**面板当前激活 run tab（切/关 tab、切到「工作区」tab、关面板自动跟随）；全屏图用自身选中 | 一面一个高亮源，**否决**反向 `selectRun` 跨 store 对账 |

**run-detail 区段构成**：头部（角色 / 状态 / 用时）、任务、错误（失败强制展开）、**思考过程**（worker 思考全文，`run_reasoning_delta` 流式；流式时自动展开、完成自动收起）、输出、工具调用、**协作关系**（`dependsOn` 依赖 + 后续）、**委派关系**（上级 + 子任务树，详见下段）、**资源消耗**（power 粒度全量 token + ¥ 明细；默认折叠，开「用量明细」时展开，¥ 总额不受该开关影响）。**独立 `reasoning` Tab 已否决**——思考全文本质 per-run，归 run-detail「思考过程」区段而非全局 Tab。→ 见代码 `RunDetailBody.tsx`。

**委派展示统一**：单一可视化（`GraphView` 一张图同表委派树与 `depends_on` 依赖）+ 单一数据模型（`AgentRun`：编排步骤与委派子 Agent 共用同一节点类型）+ `run_*` 事件族（前端不拼接两路流）。**被否决**：前端按 N 隐藏其一（状态仍分叉）；保留双协议只在前端合并（双写漂移）。

**run-detail「委派关系」区段**（阶段2 嵌套委派）：worker 详情在「协作关系」（`dependsOn` 上游 依赖 / 下游 后续，横向同波次）之外另设「委派关系」区段——「上级」是委派它的 captain worker（仅当父 run 是本回合图上的真实节点才显；顶层 worker 的父是 CEO captain、图上无节点，故为空），「子任务」按 `parentRunId` 递归缩进成树、点行下钻该子 run。两者**并列而非混淆**：DAG 边横向（同波次依赖），委派边纵向（嵌套层级）。→ 见代码 `RunDetailBody.tsx`。

**聊天紧凑化原则**：inline 只做信号展示（思考折叠条/状态条/内嵌协作图）；面板承担完整详情（思考全文/run 全文 + 工具 IO + 用量）；失败/运行中强制展开（错误绝不藏）；协作图内嵌于回合（非面板 Tab），大图 / 回放进临时全屏。

---

## 十一、Agent 可发现性 ✅ 已确定

可发现性是 Agent 的固有属性，单独成轴，不从「被哪个团队引用」反推。三态：`public`（上架，进发现/搜索，并入 CEO **智能路由**的可用人才池）、`unlisted`（后台构件，不进发现面但按 id 可直达）、`private`（仅创作者可见）。**可发现 ≠ 用户手选**：可发现只是把 agent 喂进 CEO 的人才池由智能路由自动组团，**不给用户开「选择器」菜单**（手选 = 替代 CEO 调度、制造双决策逻辑，已否决）。

**设计原则**：单一谓词（一处过滤 `visibility=public` 覆盖全部发现入口）；`is_featured` 解耦（回归「编辑精选」本职，与可见性正交）；缺省 public（避免误隐藏）；组件型默认 unlisted（团队成员/队长/竞技场角色）。

**被否决**：把 Arena 角色拆成独立实体——违背 Multi-Agent First，破坏 Arena 槽位可插拔。

---

## 十二、工具箱（卡片网格）

> **已落地**：工具箱页（`/toolbox`）为卡片网格 IA（→ 见代码 `pages/ToolboxPage.tsx`）；「AI 工具」子页复用内置动作工具只读目录（`BuiltinToolCatalog`，→ 见代码 `pages/toolbox/AiToolsPage.tsx`）。本节为关键决策；工具/产物模型见 [`工具与能力系统.md` §8.4](/docs/03-AI核心/工具与能力系统.md)。

工具箱页用**卡片网格**（`auto-fill minmax(260px,1fr)`，磁贴：图标居左 + 标题/副文 + 右侧 `›` 或「即将上线」徽章），按两组**轻量小标题（非 Tab）**排布：

- **创作工具**：文档 / 思维导图 / 多维表格 / 画布 / 幻灯片 / 可运行产物 / 流程图 / 表单——各为一种产物类型，点击进「该类型产物列表 + 新建」。
- **能力**：AI 工具（点开 = 内置动作工具只读目录 `/toolbox/ai-tools`）/ 集成 · 连接器（MCP & 第三方）/ 工作流（编排工具 + Agent）。

**关键决策**：两组用小标题而非 Tab——一屏纵览全部能力、零层级切换。**现状**：除「AI 工具」外均为占位（「即将上线」）；各创作工具的编辑器与「产物列表 + 新建」流程归 `file` / `table` 体系，多为 Post-MVP（见 [`工具与能力系统.md` §8.4](/docs/03-AI核心/工具与能力系统.md)）。

---

## 十三、质量档设置页（现状）

> **已落地**：`/more/model-modes`（MorePage「质量档」）。用户以**团队语言**为 Agent 团队选模型——内部 profile 名（`chat` / `agent.strong` / `agent.fast`）永不外露。前后端共享一套词表（`lib/modelModes.ts`）与缓存（`stores/modelModes.ts`，对话输入框 `ModeSelector` 同源，故设置页 CRUD 后选择器即时刷新）。本节为关键决策；档位解析 / 运营 ceiling 等后端语义见 [`../03-AI核心/编排器与CEO主Agent.md` §2.1](/docs/03-AI核心/编排器与CEO主Agent.md) 与代码 `llm/modes.py`、`api/routes/model_modes.py`。

**模型**：一个「质量档」= 团队角色 → 模型的映射。角色三类（CEO 本体 / 主力 worker / 经济 worker），仅前两者可配；**经济 worker 锁定 Flash**（决策：经济档「按定义就便宜」，升 Pro 自相矛盾，仅只读展示）。系统预设两枚只读（`经济档` = 全程 Flash = 系统默认 / `高质量档` = CEO 本体 + 主力 worker 升 Pro），用户可在运营 ceiling 内新建自定义档。解析优先级：对话 → 用户默认 → 运营默认 → 系统默认（经济）；未知 / 已删档回落经济，绝不让模型配置问题打断回合。

**一个统一列表**（核心决策，反「选默认」与「浏览档位」割裂）：页面收敛为单列表——顶部「跟随系统默认」行 + 系统预设 + 我的质量档，每行左侧 radio，**点选即设为账号默认**（乐观更新 + 持久化），选中行打「默认」徽章。**否决**原「顶部 `<select>` 选默认 + 下方重复列预设 / 自定义」的双表达（选完看不出哪个是默认、信息重复）。

| 行内元素 | 说明 |
|---|---|
| radio（设默认） | 点选即账号默认；「跟随系统默认」行解析为运营默认并显示当前落点；每对话仍可在输入框单独切换 |
| 角色→模型摘要 | 预设与自定义**同一种**「CEO 本体 → Pro」展示（反原预设用文案、自定义用映射的不一致） |
| 成本徽章 | 由 assignments 推导 `基准 / 中等 / 较高` 三档（`muted` / `info` / `warning`）；**定性而非假的 ×**——真实花费取决于各角色 token 占比，只给档不给伪精度 |
| 展开团队 | 点行展开，列三个角色（含锁定的经济 worker）的最终模型 + 成本注 |
| 编辑 / 删除 | 仅自定义档；删除为**行内确认**（不弹原生 `window.confirm`，与设计系统一致） |

**健壮性决策**：catalog（可配角色 + ceiling 模型）加载失败 → 错误条 + 重试并禁用「新建」（不静默消失）；删除「当前默认档」先回退到跟随系统默认，**避免悬空默认 id**（后端 soft-delete 不清 `default_model_mode`）；首屏骨架占位。

> 此处「成本徽章」是**档位相对成本定性**（选档时的决策辅助），与 [`前端成本呈现.md`](/docs/04-前端/前端成本呈现.md) §七的**实际 ¥ 记账呈现**是两套东西，勿混。

→ 见代码：`pages/more/ModelModeSettings.tsx`、`lib/modelModes.ts`（词表 + `modeCostTier` / `effectiveRoleModel`）、`stores/modelModes.ts`、`components/chat/ModeSelector.tsx`；后端 `llm/modes.py`、`api/routes/model_modes.py`。

---

## 十四、全局搜索与命令面板（现状）

`Ctrl/Cmd+K` 打开的命令面板（`CommandPalette`）= Tier 1 全局搜索。

- **空查询**：显示最近对话（客户端取已水合列表，零后端、低惊讶）。
- **有查询**：300ms 防抖后调 `GET /v1/search`，按**对话 / 消息 / 文件夹**分组展示；消息命中显示所属对话标题 + 命中 snippet（高亮命中片段）。
- **键盘导航**：结果跨组扁平为一条列表，↑↓ 移动、Enter 执行、Esc 关闭；鼠标 hover 同步高亮选中项。
- **跳转**：对话 → 打开对话；消息 → 打开对话并滚动定位到该消息（窗外消息走 load-around 拉上下文窗口，**命中必达**，见技术文档 §9.7）；文件夹 → 跳转对话管理页 `/conversations`（经路由 state 传递目标）并选中 + 闪烁该文件夹（取代早期「展开左侧栏闪烁该分组」——分组已随侧栏精简迁至管理页）。
- **状态**：加载中（输入框内 spinner）、无结果、搜索失败各有明确提示。
- **文案**：占位符「搜索对话、消息、文件夹…」、标题栏按钮「搜索…」——**不在命令存在前过度承诺**，Tier 2 命令落地后再改「搜索与命令…」。

技术契约见 [`前端技术与架构.md` §9.7–9.8](/docs/04-前端/前端技术与架构.md)。Tier 2（命令面板：搜索叠加导航 / 动作）/ Tier 3（pgvector 语义搜索）为未落地 backlog，见 [`07-规划/就绪路线图.md` §四](/docs/07-规划/就绪路线图.md)。

---

## 十五、待定事项

| 议题 | 说明 |
|------|------|
| 移动端适配 | 图视图在手机端如何简化 |
| 多任务同时进行 | 多个任务并行时图视图如何呈现 |
| 历史任务回放 | 图视图内帧流回放已落地（`Timeline`）；跨会话回放完整历史任务待定 |
| 无障碍访问 | 图视图的键盘导航和屏幕阅读器支持 |
| 离线态 UX | 已连接但目录不可达时的降级展示 |
