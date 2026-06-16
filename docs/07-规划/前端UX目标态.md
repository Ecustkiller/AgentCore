# 前端 UX 目标态（未落地 UI 规格）🗂️

> **定位**：仅存**未落地**的前端 UX 目标设计。已落地部分全部迁回现状专题文档（[`04-前端/前端UX设计.md`](/docs/04-前端/前端UX设计.md) / [`前端技术与架构.md`](/docs/04-前端/前端技术与架构.md)），对应条目随落地从本文退役（含原「详情面板/任务卡片/辩论展示/图视图交互/侧栏分组」诸节，及已否决的 Slash 命令、Agent/Team 选择器、气泡内工具卡、各类输入框 pill、工具点节点、拖拽移动对话——否决理由已就地写入现状文档；**多轮辩论 Arena 亦已落地于 DAG、独立子系统已否决**，见下 §三；**结构化挂起 Phase 2a 前端亦已落地**，见下 §二/§四）。当前含：**信息层次模型（蓝图）+ §五 工作区面板 IA 重设计（🗂️ 提案，方向已定、待落地）**。

---

## 一、信息层次模型（Layer 0–4）

设计模型：单 Agent 回合默认只见输出（Layer 0）；多 Agent 回合的状态/进度/协作由内嵌图承担（Layer 1–3）；点节点把单 run 全文下钻到面板（Layer 4）。其他文档以「目标态 §一」指向此处。

> 落地形态（内嵌协作图 / `SidePanel` 下钻）已是现状 → 见 [`前端UX设计.md` §一 / §三 / §十](/docs/04-前端/前端UX设计.md)。

---

## 二、结构化挂起（✅ 已落地 → 迁出）

Phase 2a 前端已落地：`PlanReviewCard` 会话流卡片 + 图节点暂停徽标（`AgentNode` ⏸ 徽标）。→ 见 [`前端UX设计.md` §三 / §五](/docs/04-前端/前端UX设计.md)。分阶段蓝图曾载于 [`结构化挂起后端落地设计.md`](/docs/07-规划/结构化挂起后端落地设计.md)（2b 全落地后全文退役）。

---

## 三、多轮辩论 Arena — 已退役（落地于 DAG / 独立子系统已否决）

曾设想为「阶段轮转 + 独立 `arena` SSE + 状态机」的辩论专用子系统；结论：**多轮来回交锋 = 跨轮 `depends_on` + 上游产物注入**，已端到端落地于普通 DAG（前端逐轮渲染见 [`前端UX设计.md` §四](/docs/04-前端/前端UX设计.md)），独立子系统**已否决**（其余要素属共享 Phase 2 基建或冗余）。决策全文（被否决理由 + 唯一残留的「运行期决定轮数」边际项）见 [`Agent协作模式.md` §7.4](/docs/03-AI核心/Agent协作模式.md)。本文不再保留 Arena 前端规格。

---

## 四、图检查点节点（✅ 已落地 → 迁出）

Phase 2a 采用**方案 A**：检查点步骤 `AgentNode` 暂停徽标（非独立 `CheckpointNode`）。→ 见 [`前端UX设计.md` §五](/docs/04-前端/前端UX设计.md)。性能约束（≤50 节点、≥60fps）见现状 [`前端UX设计.md` §八](/docs/04-前端/前端UX设计.md)。

---

## 五、工作区面板信息架构重设计（🗂️ 提案 · 方向已定 / 未落地）

> **范围**：仅重构 `SidePanel` 内「工作区 home tab」的**内部** IA（模式条 + 文件/快照/交接 三段）。外层「工作区 home + run 详情 tab」模型（§一 落地形态，见 [`前端UX设计.md` §十](/docs/04-前端/前端UX设计.md)）**不动**；纯前端、不改后端契约。落地后本节迁回 [`04-前端/前端UX设计.md`](/docs/04-前端/前端UX设计.md)。

### 1. 现状诊断

打开工作区要穿过 **4 条横栏**才到文件内容（面板宽 `280–560px`、默认 400，见 [`stores/sidePanel.ts`](/apps/desktop/src/renderer/stores/sidePanel.ts)）：① `SidePanel` 标签条 → ② `WorkspaceModeBar` 模式整行 → ③ 文件/快照/交接 三 section tab → ④ 文件操作条。三个真问题：

- **chrome 过厚**：②③ 两整行可压成一行。
- **低频却平级常驻**：日常高频只有「文件」；「快照」（恢复）「交接」（PR 评审）是低频/恢复型操作，与文件同级一直占位 → 视觉分量过重。
- **交接放错容器**：PR 三方评审 + 逐文件解冲突塞进 ≤560px 面板，diff 极挤。

### 2. 目标 IA（方案一：文件即主体）

把 ②③ 压成**一条头栏**，文件树成为面板默认主体：

| 区 | 内容 | 形态 |
|---|---|---|
| 头栏·左 | 模式 pill `☁ 云端 ▾` / `💻 ~/proj ▾` | 点开 popover 承载「绑定本地文件夹 / 切回云端 / 重连 / 备份到云」（收编 `WorkspaceModeBar` 整行）；降级态（本地根丢失）pill 变红带角标 |
| 头栏·中 | 上传 / 新建文件 / 新建文件夹 | 沿用 `FilesSection` 现有操作 |
| 头栏·右 | 🕘 快照 · ⤴ 交接 | 图标按钮，按需打开浮层，不再常驻 tab |
| 主体 | 文件树 / 预览编辑器 | 占满剩余高度（取消「文件」tab——工作区打开即文件） |

- **快照**：右上 🕘 → slide-over / popover 列表（恢复 / 下载 zip / 手动留版本）。
- **交接（采纳方案 A · 宽模态）**：右上 ⤴ → 派发 / 轮询在浮层；进入 **PR 评审**升级为**居中宽模态 / 全屏路由**（参照 [`pages/toolbox/TeamMechanism.tsx`](/apps/desktop/src/renderer/pages/toolbox/TeamMechanism.tsx) 的 `fixed inset-0` 真全屏自绘窗口控件），给三方 diff 足够横向空间——面板 ≤560px 装不下逐文件评审。

### 3. 落地影响面（前端拆分 · 低风险）

| 文件 | 改动 |
|---|---|
| [`components/workspace/WorkspacePanel.tsx`](/apps/desktop/src/renderer/components/workspace/WorkspacePanel.tsx)（1296 行） | 拆成 文件树 / 预览编辑器 / 快照浮层 三个文件；删 `SectionTab` + section 切换 |
| [`components/workspace/WorkspaceModeBar.tsx`](/apps/desktop/src/renderer/components/workspace/WorkspaceModeBar.tsx) | 常驻行 → 模式 pill + popover |
| [`components/workspace/HandoffSection.tsx`](/apps/desktop/src/renderer/components/workspace/HandoffSection.tsx) | 逻辑保留；外壳由 tab 内容改为「图标触发 + PR 评审宽模态」 |
| [`stores/sidePanel.ts`](/apps/desktop/src/renderer/stores/sidePanel.ts) | `WorkspaceSection` / `section` 简化（文件常驻；快照/交接改瞬态开关、可不持久化） |

> 备注（非本节）：截图里文件面板转圈（`conversationId` 在、`listWorkspaceFiles` 未返回）属运行时 bug，与 IA 无关，单独排查。
