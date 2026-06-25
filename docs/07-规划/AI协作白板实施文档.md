# AI 协作白板实施文档 🗂️

> **定位**：本文是 [`AI协作白板产品设计.md`](/docs/07-规划/AI协作白板产品设计.md) 的**工程落地篇**——只回答「**怎么把白板做进 `apps/desktop`（一个新页面/路由）**」。产品层的 why / what / 差异化见设计文档，本文只记**工程决策、接缝、施工序列**（[doc-governance](/.cursor/rules/doc-governance.mdc)：只写代码看不出来的东西）。
>
> **治理**：本目录仅 `07-规划`；🗂️ = 讨论中、未承诺落地。状态标记：**✅** = 已拍板 / 沿用设计文档已对齐项；**⏳** = 本文待确认项（新依赖 / 架构选型按「AI 提案 → 人确认」，[dev-process](/.cursor/rules/dev-process.mdc)）。决策通过后，脚手架/契约迁入 `02-架构` / `04-前端`，本文退役。
>
> **来源**：2026-06-25 讨论：先起 strawman（曾按 B 独立 web app），经「三问」压测后**改定 A：白板做进 desktop 内一个页面**（§二.1）。

---

## 一、施工序列总览（gate 在前）

实施能推进多深，取决于几道 gate 先不先清。**关键发现：§九 里两项「待议」其实反向 gate 住 M1 的数据模型**——不是远期议题，是开工前置。

| Gate | 决策归属 | 阻塞什么 | 决策（✅ 全部已定 2026-06-25） |
|---|---|---|---|
| **G1 渲染引擎** ✅ | AI 提案→人确认 | M1 全部 | v1 用 **stock Excalidraw（MIT $0）**（设计文档 §四）；原生 Agent 节点推迟到验证刚需 |
| **G2 落地形态** ✅ | 人直接决定 | M1 | **desktop 内白板页面/路由**（`apps/desktop`，同 origin，复用桌面 auth/run/SSE）；否决独立 web app（§二.1） |
| **G3 board↔folder 关系** ✅ | AI 提案→人确认 | M1 数据模型 | board **归属一个 folder 工作区**（复用现有 `folders` 用户作用域，[`folders.py`](/apps/server/agentcore/api/routes/folders.py)） |
| **G4 白板存储** ✅ | AI 提案→人确认 | M1 数据模型 | **独立 `boards` 表 + scene blob**；小场景内联 JSONB、超阈值落 S3（§四） |
| **G5 AI ops 通道** ✅ | AI 提案→人确认 | M2 | AI 摆元素走**新内建工具进 `tools/catalog`**，而非新裸 REST 端点（复用 run/工具协议） |
| **G6 读图通道** ✅ | AI 提案→人确认 | M2 | **选区栅格化 → `/v1/inference` 视觉模型**（宿主侧导出，不依赖引擎内部） |

> M3（拉团队干活）不单列 gate，但有一个**接入点待确认**：复用现有「发起 AI run + SSE 事件流」的确切入口（见 §五）。

---

## 二、落地形态：desktop 内一个白板页面（✅ G2 = A）

**决策**：白板**不**做成独立 app，而是 **`apps/desktop` 渲染层里的一个新页面/路由**，与桌面**同 origin `app://agentcore`、同构建、同认证、同发版列车**。理由见 §二.1。

| 维度 | 取值 | 复用桌面现成 |
|---|---|---|
| 页面 | `pages/WhiteboardPage.tsx`（全屏画布，照 `/toolbox/manual` 全屏页范式） | ✅ desktop-layout 全屏页豁免 |
| 路由 | `router.tsx` 加 `{ path: "whiteboard", element: <WhiteboardPage /> }` | ✅ 现有 HashRouter |
| 导航 | `sidebar/Sidebar.tsx` 的 `NAV_ITEMS` 加一项（lucide 图标 +「白板」+ `/whiteboard`） | ✅ 现有侧栏 |
| 认证/会话 | **零接线**——同 origin，复用 `services/api.ts`（凭证式 + 401 refresh + CSRF） | ✅ |
| 配色 | 包裹层只用 `@agentcore/design-tokens` 语义 token（[color-tokens](/.cursor/rules/color-tokens.mdc)）；Excalidraw 自带样式属 vendored | ✅ |
| 契约 | 复用 `@agentcore/contract-rest-types`（boards 端点落地后重生成） | ✅ |
| 依赖 | `apps/desktop/package.json` 加 `@excalidraw/excalidraw`（React 19 兼容：peer `^17 || ^18 || ^19`；嵌套 radix 旧 peer 仅告警，非阻断） | — |

### 二.1 为什么 A 不是 B（决策依据，2026-06-25）

被否决方案：**B 独立 web app（`apps/whiteboard`）+ 桌面窗口入口**。否决理由（三问压测后）：

- **受众**：web 触达「不太需要」——不面向不装 app 的外部用户。
- **协作**：要的是「自己人同板」（都装了 app 的用户 / 多 Agent），靠**后端 sync** 即可，桌面 app 照样能做（Figma / Linear / Notion 桌面端皆如此）——**协作 ≠ web**。只有「外部链接分享给没装 app 的人」才逼出 web，而那条已判「不太需要」。
- **工程**：A 进程内全复用桌面 auth / chat / files / run / SSE，M2/M3 显著更省。
- **已接受风险**：万一日后要「外部链接分享」，A→web 回填较贵（基本重写为独立 web app）；届时再走内嵌 / co-bundle。

---

## 三、Excalidraw 集成层（L1+L2 落地）

设计文档 §4.3「AI 读写两家无代差」已论证 Excalidraw 够用，本文落到**怎么接**。引擎已定（**G1 ✅ stock Excalidraw**）。

- **依赖**：`@excalidraw/excalidraw`（设计文档 §四核实 v0.18，MIT）；架构图链路复用 `@excalidraw/mermaid-to-excalidraw`。
- **读**：持有 `excalidrawAPI` ref → `getSceneElements()` 取纯 JSON 数组喂 LLM；`onChange(elements, appState, files)` 实时盯板驱动 autosave。
- **写**：AI 只产**简化骨架** → `convertToExcalidrawElements`（自动补 seed/version）→ `updateScene({ elements })`。`updateScene` 是替换式，宿主侧维护 `id→element` map 做局部更新。
- **自定义元素元数据**：Excalidraw 无原生自定义形状，AgentCore 特有的三类元素挂在 `customData` 上，并**显式版本化**（防 scene 迁移坑）：
  - `briefRegion`（人圈给 AI 的手绘/截图需求）
  - `agentNode`（一次 run 的入口与进度，L2 用 `embeddable`+`renderEmbeddable` 渲染可交互卡）
  - `artifactCard`（team 产物回贴，可 `@` 回工作区）
- **布局助手**：AI 只管「画什么 + 谁连谁」，**位置交给宿主侧算法**（grid / dagre），规避 LLM 算坐标。

> `customData` schema 形如 `{ kind: "agentNode", schemaVersion: 1, runId, status }`——`schemaVersion` 是后悔药，先留好。

---

## 四、数据模型与契约

- **`boards` 表（Postgres）**：`id` / `user_id` / `folder_id`（G3）/ `title` / `scene`（小场景内联 JSONB）/ `scene_blob_ref`（超阈值 S3 指针，G4）/ `version`（CAS）/ `created_at` / `updated_at`。
- **存储阈值（G4 ✅）**：scene JSON < **256 KB** 内联行内 JSONB；≥ 256 KB 落 S3、行内只存 `scene_blob_ref`。autosave 防抖 **~1.5s**；版本历史 = 保留**最近 K 次 autosave + 显式命名快照**（K 默认 20，实现细节可调）。
- **REST 契约**：新增 `/v1/boards` CRUD，**照 [`folders.py`](/apps/server/agentcore/api/routes/folders.py) 范式**——`AuthUser` 作用域、非属主 404（IDOR-safe）、`repository` 模式、Pydantic schema 在 route 层转换。CAS 写法照 [`memory.py`](/apps/server/agentcore/api/routes/memory.py)：full text + `version` baseline，冲突回 `conflict` 不覆盖。
- **类型单一源**：route + schema 落地后 → 重生成 `pnpm -C packages/contract-rest-types gen`（`openapi-typescript apps/server/openapi.json`），白板前端 import 生成类型，不手写。
- **DB 迁移**：alembic 新 revision（照 `db/migrations/versions/` 现有范式）。

---

## 五、后端接线（零新编排，守绊线）

白板**复用桌面客户端现有的** run 发起 + 事件流（进程内），不动 engine / loop / 调度（[dev-process 补丁绊线](/.cursor/rules/dev-process.mdc)）。

| 地基 | 复用方式 |
|---|---|
| 账号 / 认证 | **零接线**：白板是 desktop 内页面，同 origin 复用 `services/api.ts`（凭证式会话 + 401 refresh + CSRF），无新 CORS / 登录 gate |
| 发起团队 run（M3） | **进程内**复用桌面现有发起 AI run 的通道（`delegate` / `debate` / pipeline）：白板选区 → 组 brief → 起 run |
| 事件流 | 复用 SSE / 协议 fold，把 run 进度渲染成 `agentNode` 状态 |
| LLM / 读图 | 复用 `/v1/inference`（含视觉模型，G6） |
| 产物回贴 | 复用 `files` / 工作区；board ↔ 工作区加**导出接缝**（board → 图 / md / 产物入工作区），不反向破坏文本典范 |
| 存储 | Postgres + S3（§四） |

> **协议 fold**：白板是新渲染面，组件层不进 conformance；`agentNode` 状态**直接复用桌面现有 run 事件 fold**（`conformanceFold`，已过 conformance），零新增 fold（[protocol-conformance](/.cursor/rules/protocol-conformance.mdc)）。

---

## 六、里程碑任务拆解（带验收标准）

> 「AI 第一天就进」是产品要求，M1–M3 **同属 v1**；工程上仍按引擎→助手→团队分步交付。

### M1 白板骨架（依赖 G1/G2/G3/G4 ✅ 全部已满足）
- 任务：`apps/desktop` 加 `@excalidraw/excalidraw` → `WhiteboardPage`（全屏嵌 Excalidraw）→ 路由 + 侧栏「白板」入口 →（先 localStorage autosave 跑通）→ 落 `boards` 表 + `/v1/boards` + autosave 落库。
- **验收**：侧栏「白板」可进；能画 / 平移 / 缩放；建 / 存 / 开 board；刷新不丢；autosave 冲突回 `conflict` 不覆盖。

### M2 AI 助手进板（依赖 G5/G6 ✅ 已定）
- 任务：AI ops 适配器（add/move/connect/group → skeleton → updateScene）+ 布局助手；接视觉模型读 `briefRegion`；一个 AI 操作入口（选区 →「帮我整理 / 生成结构」）。
- **验收**：选区 → AI 加便签 / 连线 / 排流程可见；手绘 brief 能被读懂并据此摆元素。

### M3 AI 团队照白板干活（依赖 §五接入点）
- 任务：白板选区 →「让团队照这实现」→ 发起 run → 进度回贴 `agentNode` → 产物回贴 `artifactCard`。
- **验收**：Hero 故事端到端跑通；产物可 `@` 回工作区。

每步「现有后端原语 + 白板新前端」，**后端零新基建**。

---

## 七、风险与护栏（工程视角）

| 风险 | 护栏 |
|---|---|
| 引擎授权 / 原生节点 | v1 stock Excalidraw（$0）；原生节点刚需时再 tldraw（付费）/ Fork（merge 税） |
| 重复造轮子 | 不把 `ConversationCanvas` / mermaid / 文件列表搬进来重做（设计文档 §一已界定） |
| AI 空间「4 失败点」回归 | AI 走结构化 ops，**绝不让 AI「画」整图** |
| scene 迁移坑 | `customData.schemaVersion` 先留好 |
| 并发写 / 协作 | 协作=自己人同板，走后端 sync（远期）；即便单人，人与 AI 也并发写板 → 定 `id→element` 合并策略 |
| 为白板改内核 | 触发即停、提根因（[dev-process 绊线](/.cursor/rules/dev-process.mdc)） |

---

## 八、决策清单（✅ 全部已定 2026-06-25）

| # | 决策 | 取值（✅ 已定 2026-06-25） | 解锁 |
|---|---|---|---|
| G1 ✅ | 渲染引擎 | stock Excalidraw（MIT $0） | M1 全部 |
| G2 ✅ | 落地形态 | **desktop 内白板页面/路由**（同 origin，复用桌面 auth/run/SSE）；否决独立 web app | M1 |
| G3 ✅ | board↔folder | board 归属 folder 工作区 | M1 数据模型 |
| G4 ✅ | 白板存储 | 独立 `boards` 表 + 内联(256KB)/S3 阈值 blob | M1 数据模型 |
| G5 ✅ | AI ops 通道 | 新内建工具进 catalog（复用 run/工具协议） | M2 |
| G6 ✅ | 读图通道 | 选区栅格化 → `/v1/inference` 视觉模型 | M2 |
| — | M3 run 接入点 | 复用现有发起 AI run 通道（确切入口 M3 定） | M3 |

> **下一步**：**全部 gate 已定**，落地形态 = desktop 内白板页面。M1 开工：① `apps/desktop` 加 Excalidraw + `WhiteboardPage` + 路由 + 侧栏入口（本次开工）；② 落 `boards` 表 + alembic 迁移 + `/v1/boards` + 重生成契约。落地后把页面/契约迁入 `04-前端` / `02-架构`，本文退役。
