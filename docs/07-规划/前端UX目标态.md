# 前端 UX 目标态（未落地 UI 规格）🗂️

> **定位**：提案/愿景，非现状。已落地部分见 [`04-前端/前端UX设计.md`](../04-前端/前端UX设计.md)；落地后迁回专题文档，本文条目退役。

---

## 一、详情面板（DetailPanel）

> **已落地并退役为现状**：`DetailPanel` 现为**纯 run-detail 下钻面板**（点内嵌协作图节点钉住该 run），原 `task-progress` / `task-graph` 双 tab 已删（进度/协作图折进内嵌图）；多 `run-detail` 可并存对比、可拖拽宽度（280–560px）、仅持久化 `open` + `width`、按 `messageId` 投影。现状与关键决策见 [`前端UX设计.md` §十](../04-前端/前端UX设计.md) + [`前端技术与架构.md` §9.2 / §9.4](../04-前端/前端技术与架构.md)。下列为仍具参考价值的信息层级模型与 run-detail 区段构成。

**信息层次**（Layer 0–4，设计模型）：单 Agent 回合默认只见输出（Layer 0）；多 Agent 回合的状态/进度/协作由内嵌图承担（Layer 1–3）；点节点把单 run 全文下钻到面板（Layer 4）。

**run-detail 区段**：头部 / 任务 / 错误 / 思考过程（worker 思考全文，✅ `run_reasoning_delta` 流式，流式时自动展开、完成自动收起）/ 输出 / 工具 / 协作关系（依赖+后续，✅）/ 资源消耗（power 粒度全量数字，✅）。「子任务」原拟按嵌套呈现，但阶段1 worker 扁平（`parentRunId` 恒空），故落地为按方向诚实展示的「协作关系」（`dependsOn` 上游/下游）；真正的嵌套子任务留待阶段2 `parentRunId`。→ 见代码 `RunDetailBody.tsx`。独立 `reasoning` Tab 已否决：思考全文本质 per-run，落地于 run-detail「思考过程」区段而非全局 Tab。

---

## 二、输入框与消息气泡

已落地项见 [`前端UX设计.md` §二](../04-前端/前端UX设计.md)。

**未落地**：Agent/Team 选择器、Slash 命令、拖拽附件、文件夹/产物 Pill；气泡内工具卡、时间戳。

---

## 三、团队状态条（原「任务卡片」）

任务卡片已退役——其职责（三态 + 救火行 + `[···]` 菜单）折进**内嵌协作图的状态条**（`InlineTeamGraph`），现状见 [`前端UX设计.md` §三](../04-前端/前端UX设计.md)。

**为何无「规划中」态**（决策，2026-06）：CEO + `delegate` 架构下 `run_plan` 同步到达，无独立规划空窗；「系统在思考」由 CEO reasoning 气泡覆盖；`tool_use_start(delegate)` 前无法预知是否组团。→ 见代码 `delegate.py`、`engine.py`。

**未落地**：独立检查点卡片（继续/调整/停止，不并入状态条）。

---

## 四、辩论/审查范式 UX

辩论是 MVP Day1 范式，但当前内嵌图状态条不区分并行/辩论。

| 维度 | 并行 | 辩论 |
|------|------|------|
| 标题 | "并行 · N 个 Agent" | "辩论 · 正方/反方" |
| 输出 | 各自折叠 | **左右并排对比** |
| 检查点动作 | 继续/调整/停止 | 采纳 A/B / 补充论证 / 用户自判 |

**SSE**：与普通多 Agent 相同；并排渲染触发信号 ⏳ 待定（或由 CEO 在 delegate 标注对立分组）；结论随 CEO 收尾 `content_delta`。

**图视图**：正方/反方并行节点 → 评审节点 → 最终输出（`arena` 节点类型）。

---

## 五、图视图

现状见 [`前端UX设计.md` §五](../04-前端/前端UX设计.md)。

**目标态增量**：多类节点（用户输入 ✅ / worker ✅ / synthesis ✅ 端点节点见 `EndpointNode.tsx`；arena / 检查点 / 工具点 ⏳，需后端或阶段2）；粒子边（✅ SVG `animateMotion`）；状态过渡动画（✅ 纯 CSS：节点错峰入场 + 完成闪烁 + 布局切换位移 morph，`prefers-reduced-motion` 降级，零新依赖，见 `useTerminalFlash.ts` + `globals.css`）；右键菜单（✅ 查看详情 / 在面板查看 / 居中 / 适应画布 / 布局切换）；布局切换（✅ 树形默认 + 左右流 + 径向 + 力导向；ELK 多算法见 `lib/elk-layout.ts`，选择持久化于 `stores/graph.ts`）；`F` 适应画布 ✅、tooltip ✅（hover + 键盘 focus 双触发，`role=button`/`aria-label` 可达）、多选 ✅（修饰键加选/框选 + `selected` 高亮）。→ 见代码 `StepEdge.tsx`、`GraphView.tsx`、`AgentNode.tsx`、`EndpointNode.tsx`。

**性能约束**：≤50 节点、≥60fps。

**技术债**：状态过渡动画已用纯 CSS 落地（`@keyframes graph-node-enter`/`graph-node-flash` + `.react-flow__node` transform 过渡），Framer Motion 否决——CSS 动画与 ReactFlow 节点定位 transform 无冲突且零依赖；粒子边已用自定义边 SVG `animateMotion` 落地；布局切换已用 ELK 多算法落地（`lib/elk-layout.ts`）；右键菜单复用 `sidebar/ContextMenu`（无需 Radix）。

---

## 六、侧栏文件夹分组

**已落地**：用户文件夹 + 未分组分组（`GET /v1/conversations/grouped`、`useFoldersStore`、`FolderGroup`）、右键菜单（重命名 / 移到文件夹 / 移出 / 新建文件夹 / 删除，复用 `ContextMenu`）、状态指示器（🟢 执行中 / 🟡 待审批：每项读自身会话切片 `useConversationGenerating(id)` + 审批项按 `conversationId` 标签，故后台 turn 切走后仍亮点，呼应「会话运行时按 conversationId 分片」见 [`前端技术与架构.md` §9.6](../04-前端/前端技术与架构.md)）。→ 见代码 `components/sidebar/ConversationItem.tsx`、`stores/folders.ts`。

**未落地**：拖拽移动对话到文件夹（⏳ 复用已有 `moveConversation`，缺 HTML5 drag 手势）。
