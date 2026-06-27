# AI 协作白板 🗂️

> **定位**：AgentCore 桌面端的一块**协作白板**（市场款无限画布，便签/形状/箭头/手绘），差异点是**白板里有一支 AI 团队**。落地为 **`apps/desktop` 内一个页面/路由**（非独立 app），**数据模型用空间 JSON 为真相**，复用 AgentCore 地基（账号、Agent 团队后端、LLM 推理、存储）。本文合并「产品设计」与「工程落地」两篇：前半（§一–§五）讲 why / what / 差异化 / 选型，后半（§六–§十二）讲怎么做进 desktop（集成 / 数据契约 / 读图设计 / 施工序列）。
>
> **治理**：本目录仅 `07-规划`；🗂️ = 本特性仍挂 07 规划目录（**M1 + M2 结构化 ops 已落地**，M2 读图 G6 + M3 未建，故未整体迁出）。状态标记：**✅** = 已落地 / 已拍板共识（架构选型 / 新依赖按「AI 提案 → 人确认」）；**⏳** = 未落地 / 待确认。M3 也落地后，产品边界迁入 `01-产品`、技术架构迁入 `02-架构` / `04-前端`，本文退役。
>
> **来源**：2026-06-25 一次「开发画布 / 白板工具」讨论。经「用户需求三问」压力测试后定调：做**真白板**、**做进 desktop（非独立 app）**、**AI 团队第一天就进**、**人主画 / AI 当助手**；落地形态曾起 strawman B（独立 web app），压测后**改定 A（做进 desktop 内页面）**（§四.1）。

---

## 一、为什么做（先对齐需求，别用技术反推）

诚实声明：这不是「技术方便 / 跟风反推需求」。讨论中先对白板做了压力测试——**白板能干的事，大半在 AgentCore 里是重复造轮子**：

| 候选需求 | AgentCore 现状 | 白板独占价值 |
|---|---|---|
| 看团队并行产出 / 对比多方案 | `ConversationCanvas`（回合→节点图）+ 并行时间线 + 辩论卡 | ❌ 大量重叠 |
| 画架构图 / 流程图 | mermaid（表达形态·已落地）+ 规划中「流程图」产物 | ❌ 文本图对 AI 共编更优（[工具与能力系统 §3.2/3.3](/docs/03-AI核心/工具与能力系统.md)） |
| 跟 AI 头脑风暴 / 视觉思考 | 聊天能聊，无「空间铺陈」 | ⚠️ 半覆盖 |
| **人手绘 / 视觉输入当需求，AI 看懂据此干活** | 无 | ✅ 文本真表达不了，**白板独有** |
| **把多个文件 / 产物空间化成「项目地图」** | 仅列表视图（`/files`） | ✅ 空间 vs 列表，互补 |

**结论**：纯白板是红海，再造一个 Miro / Excalidraw 没意义。**唯一值得做的差异点 = 白板里有一支 AI 团队**——能看懂你的手绘、按草图摆元素 / 生成结构、甚至拉团队照着白板干活。这正好兑现 AgentCore 的核心心智「管理一个 Agent 团队」（[项目上下文](/.cursor/rules/project-context.mdc)）。

> **空间 JSON 为真相，与 §3.3 不冲突**：[工具与能力系统 §3.3](/docs/03-AI核心/工具与能力系统.md)「文本为典范模型」针对的是**本可用文本表达**的协作内容；白板 scene 是**本质空间**的（手绘/位置/连线，文本真表达不了，§一已述），故用空间 JSON 当真相是必然，不与文本典范铁律冲突。

---

## 二、产品定位与差异化

- **是什么**：市场款真白板——无限画布、便签、形状、箭头、连线、手绘笔、插图、框选分组。
- **不是什么**：不是 AgentCore 内核里的「创作产物」，不是 `ConversationCanvas` 的升级版；也**不做成独立 app**（落地为 desktop 内页面，见 §四）。
- **Hero 差异点 = AI 团队进白板**：
  - **读图**：看懂你的手绘草图 / 截图当 brief（视觉模型）。
  - **摆 / 生成结构**：加便签、拉箭头、排流程、生成图骨架（结构化操作，非「手绘」）。
  - **拉团队照白板干活**：选中白板某区域 →「让团队照这个实现」→ 发起一次 Agent run →产物（文件 / 卡）回到白板。
- **AI 角色（已定）**：**人是主画手，AI 当助手**——AI 摆元素 / 生成结构 / 整理布局 / 读图执行，**不**替人「拿笔涂鸦」。

---

## 三、已对齐决策与 Gate（✅ 全部已定 2026-06-25）

> 上半 = 产品/策略共识（仍待正式确认）；下半 G1–G6 = 工程 gate（反向卡住对应里程碑的数据模型 / 施工）。
>
> **落地状态（2026-06-25 核代码）**：G1–G5 对应的 **M1 骨架 + M2 结构化 ops 已落地 ✅**；**G6 读图通道仅决策已定、代码未建 ⏳**；M3 run 接入点未动 ⏳。下表「解锁 / 影响」是**决策视角**；G6 读图施工级设计见 §九、整体施工进度见 §十。

| # | 维度 | 决策 | 解锁 / 影响 |
|---|---|---|---|
| 产品 | 产品形态 | 真白板（市场款无限画布） | 整体方向 |
| 产品 | 典范模型 | **空间 JSON 为真相**（独立产品，不受 [§3.3](/docs/03-AI核心/工具与能力系统.md) 文本典范约束） | 数据模型（§七） |
| 产品 | 产品归属 | AgentCore **桌面端的一个功能/页面**（非独立 app），复用后端地基 | 落地范围（§四） |
| 产品 | 与 AI 团队关系 | **AI 团队是核心卖点，第一天就进**（不延后 v2） | 里程碑（§十） |
| 产品 | AI 角色 | 人主画 / AI 当助手（含读图执行） | 产品体验 |
| 产品 | 复用地基 | 账号 / Agent 团队后端 / LLM 推理 / 存储 | 后端零新基建（§八） |
| G1 | 渲染引擎 | **stock Excalidraw（MIT $0）**；原生 Agent 节点推迟到验证刚需（§五） | M1 全部 |
| G2 | 落地形态 | **desktop 内白板页面/路由**（同 origin，复用桌面 auth/run/SSE）；否决独立 web app（§四.1） | M1 |
| G3 | board↔folder | board **归属一个 folder 工作区**（复用现有 folders 用户作用域，[`folders.py`](/apps/server/agentcore/api/routes/folders.py)） | M1 数据模型 |
| G4 | 白板存储 | 独立 `boards` 表 + scene blob；<256 KB 内联 JSONB，≥256 KB 落 S3（§七） | M1 数据模型 |
| G5 | AI ops 通道 | AI 摆元素走**新内建工具进 `tools/catalog`**（复用 run/工具协议），非裸 REST | M2 |
| G6 | 读图通道 | **选区栅格化 → `/v1/inference` 视觉模型**（宿主侧导出，不依赖引擎内部） | M2 |
| — | M3 run 接入点 | 复用现有发起 AI run 通道（确切入口 M3 定，§八） | M3 |

---

## 四、落地形态：desktop 内白板页面（✅ G2 = A）

**决策**：白板**不**做成独立 app，而是 **`apps/desktop` 渲染层里的一个新页面/路由**，与桌面**同 origin `app://agentcore`、同构建、同认证、同发版列车**。理由见 §四.1。

| 维度 | 取值 | 复用桌面现成 |
|---|---|---|
| 页面 | `pages/WhiteboardPage.tsx`（全屏画布，照 `/toolbox/manual` 全屏页范式） | ✅ desktop-layout 全屏页豁免 |
| 路由 | `router.tsx` 加 `{ path: "whiteboard", element: <WhiteboardPage /> }` | ✅ 现有 HashRouter |
| 导航 | `sidebar/Sidebar.tsx` 的 `NAV_ITEMS` 加一项（lucide 图标 +「白板」+ `/whiteboard`） | ✅ 现有侧栏 |
| 认证/会话 | **零接线**——同 origin，复用 `services/api.ts`（凭证式 + 401 refresh + CSRF） | ✅ |
| 配色 | 包裹层只用 `@agentcore/design-tokens` 语义 token（[color-tokens](/.cursor/rules/color-tokens.mdc)）；Excalidraw 自带样式属 vendored | ✅ |
| 契约 | 复用 `@agentcore/contract-rest-types`（boards 端点落地后重生成） | ✅ |
| 依赖 | `apps/desktop/package.json` 加 `@excalidraw/excalidraw`（React 19 兼容：peer `^17 || ^18 || ^19`；嵌套 radix 旧 peer 仅告警，非阻断） | — |

### 四.1 为什么 A 不是 B（决策依据，2026-06-25）

被否决方案：**B 独立 web app（`apps/whiteboard`）+ 桌面窗口入口**。否决理由（三问压测后）：

- **受众**：web 触达「不太需要」——不面向不装 app 的外部用户。
- **协作**：要的是「自己人同板」（都装了 app 的用户 / 多 Agent），靠**后端 sync** 即可，桌面 app 照样能做（Figma / Linear / Notion 桌面端皆如此）——**协作 ≠ web**。只有「外部链接分享给没装 app 的人」才逼出 web，而那条已判「不太需要」。
- **工程**：A 进程内全复用桌面 auth / chat / files / run / SSE，M2/M3 显著更省。
- **已接受风险**：万一日后要「外部链接分享」，A→web 回填较贵（基本重写为独立 web app）；届时再走内嵌 / co-bundle。

---

## 五、渲染引擎选型（新依赖，AI 提案 → 人确认 · 已采纳 G1）

### 五.1 否决「纯自造」

生产级无限画布是**纯地基苦力**——手绘笔迹平滑（perfect-freehand 类算法）/ **箭头吸附与重路由**（业界公认地狱级）/ **画布内中文 IME 文字编辑** / 多选变换 / 对齐吸附 / 撤销重做 / 序列化迁移 / 多人多 Agent 协作 CRDT。这些对护城河（AI 团队）**零贡献**。

> **「AI 开发很快，自己造是否更合适？」——不成立。** AI 让「写代码」变快，但白板引擎的成本**不在打字**，在上述领域难题 + 多年踩坑攒出的边界 case（对人、对 AI 一样难）。AI 能给「能跑的 demo」，但 demo → 「人敢把真实工作存进去的生产级白板」之间是 80% 的长尾。更关键是**机会成本**：把宝贵的 AI 开发速度砸在「重造一个已被解决的画布」上，等于火力对准了**不产生差异**的地方。**且省授权费也无需自造：Excalidraw 是 MIT、$0、可商用。** 故：嵌成熟引擎（自造的合理变体是「Fork 成熟引擎」，见 §五.4 的 L3）。

### 五.2 三个候选对比（2026-06 核实）

| 维度 | **tldraw** | **Excalidraw（stock）** | **Fork Excalidraw** |
|---|---|---|---|
| 授权 / 成本 | SDK 4.0 起**生产须 license key**；**商用按年付费**（联系销售、去水印）；试用 100 天无水印、hobby 带「made with tldraw」水印且限非商用 | **MIT 全免费**、可商用、无水印 | **MIT $0**（改后代码归你） |
| AI 读写画布 | ✅ 强（Editor API / store listener） | ✅ **强**（skeleton API + `updateScene` + `onChange`，见 §五.3） | ✅ 强（继承 Excalidraw） |
| 自定义形状（Agent 节点原生度） | ✅ **原生一等**（自定义形状 = React 组件，开箱即用） | ⚠️ 无原生自定义形状；只能 embeddable / widget「近似」 | ✅ 可改核心做成原生（代价见 §五.4） |
| 长期维护 | 引擎方维护、你只用 API | 引擎方维护、你只用 API | ⚠️ **merge 税**：上游更新需 rebase 自有改动 |
| 美学 | 产品级、可定制 | 手绘草图风（特色，未必匹配「产品」气质） | 同 Excalidraw（可改） |
| 生态 | 活跃（SDK 4.0+） | 极成熟（125k★、v0.18，2026-04） | — |

### 五.3 关键发现：AI 读写画布，两家无代差

护城河（AI 团队上画布）依赖 AI 顺畅读写画布——这点 **Excalidraw 完全够，且是它的强项**：

- **读**：`getSceneElements()` 返回**纯 JSON 数组**（天然适合塞 LLM 上下文）；`onChange(elements, appState, files)` 实时盯板。
- **写**：`updateScene({ elements })` 一把更新；⭐ **Skeleton API `convertToExcalidrawElements`** 让 AI 只写简化骨架（`{ type:"rectangle", x, y, label:{text} }`），自动补全 seed/version 等底层字段——**专为程序化生成设计，对 LLM 极友好**；**箭头绑定也能在骨架里表达**（`{ type:"arrow", start:{id}, end:{id} }` → 真绑定两节点）。
- **官方已趟平「AI → 图」**：`@excalidraw/mermaid-to-excalidraw`（`parseMermaidToExcalidraw` → 骨架 → `convertToExcalidrawElements`），即 excalidraw.com「Text to diagram」同款链路——我们「AI 生成架构图骨架」可直接复用。
- **工程细节（非坑）**：空间布局建议宿主侧加布局助手（网格 / dagre），AI 只管「画什么 + 谁连谁」，位置交给算法；`updateScene` 为替换式，局部改维护 id→element map；多 Agent 并发写需合并策略（**与选哪个引擎无关**，tldraw 亦然）。

**结论**：就 AI 读写而言 tldraw / Excalidraw **无碾压**；两家唯一真分歧只在「自定义形状」（§五.4）。

### 五.4 唯一真分歧：Agent 节点要不要「原生形状」

Excalidraw 原生图形是**封闭集合**（矩形/圆/菱形/箭头/线/手绘/文字/图片/frame/embeddable），无「注册自定义形状」一等机制。把「Agent 任务节点 / 产物卡」放上画布有三级阶梯：

| 阶梯 | 做法 | 解锁 | 代价 |
|---|---|---|---|
| **L1** 不改源码 | `excalidrawAPI` 脚本化 + `customData` 挂元数据 + 侧栏/浮层放 AI UI | Hero 的 80–90%（AI 读图 / 摆元素 / 生成结构 / 侧栏指挥） | AI UI 在画布周边，非画布内 |
| **L2** 不改源码 | `embeddable`+`renderEmbeddable`（渲染自有 React）或官方 custom-element widget | 画布上出现**可交互 Agent 卡**（按钮 / 进度条） | 「先选中再操作」隔阂；箭头绑定 / 吸附拿不到原生待遇 |
| **L3** Fork 改核心 | 往元素模型加原生 `agentNode` 类型（渲染 / 命中 / 绑定 / 序列化 / 属性面板） | Agent 节点与矩形**完全平权**（原生绑定 / 吸附 / 缩放 / 协作） | 工程深 + **merge 税** |

tldraw 的卖点正是 **L3 开箱即用、无需 fork**——所以它收费。

### 五.5 提案与结论（已采纳：stock Excalidraw）

1. **v1 用 stock Excalidraw（L1+L2，MIT $0）** ⭐——AI 读写无瓶颈、零授权费、零 fork 负担，Hero 大头可达；唯一牺牲是「Agent 节点非原生形状」，用 L2 卡片大概率够用。
2. **若「画布内原生 Agent 节点」被验证为刚需**，二选一：**tldraw**（付费买掉 fork 税、原生开箱）或 **Fork Excalidraw**（$0 + 控制权，但背 merge 税）。
3. 两者 scene 格式不同（`.tldr` vs `.excalidraw`），**事后换引擎不便宜**；但 v1 锁 Excalidraw 后，tldraw 与 Fork 都属「需要时再升级 L3」，**不必现在定**。

> **决策（已定 G1）**：采纳「**v1 先 stock Excalidraw、把原生 Agent 节点的引擎决策推迟到验证刚需时**」。若日后原生节点成刚需，再在 tldraw（付费买掉 fork 税）vs Fork Excalidraw（$0 + merge 税）间二选一——属新依赖 + 可能费用的决策，届时仍须人拍板。

---

## 六、Excalidraw 集成层（L1+L2 落地）

§五.3「AI 读写两家无代差」已论证 Excalidraw 够用，本节落到**怎么接**。引擎已定（**G1 ✅ stock Excalidraw**）。

- **依赖**：`@excalidraw/excalidraw`（§五核实 v0.18，MIT）；架构图链路复用 `@excalidraw/mermaid-to-excalidraw`。
- **读**：持有 `excalidrawAPI` ref → `getSceneElements()` 取纯 JSON 数组喂 LLM；`onChange(elements, appState, files)` 实时盯板驱动 autosave。
- **写**：AI 只产**简化骨架** → `convertToExcalidrawElements`（自动补 seed/version）→ `updateScene({ elements })`。`updateScene` 是替换式，宿主侧维护 `id→element` map 做局部更新。
- **自定义元素元数据**：Excalidraw 无原生自定义形状，AgentCore 特有的三类元素挂在 `customData` 上，并**显式版本化**（防 scene 迁移坑）：
  - `briefRegion`（人圈给 AI 的手绘/截图需求）
  - `agentNode`（一次 run 的入口与进度，L2 用 `embeddable`+`renderEmbeddable` 渲染可交互卡）
  - `artifactCard`（team 产物回贴，可 `@` 回工作区）
- **布局助手**：AI 只管「画什么 + 谁连谁」，**位置交给宿主侧算法**（grid / dagre），规避 LLM 算坐标。

> `customData` schema 形如 `{ kind: "agentNode", schemaVersion: 1, runId, status }`——`schemaVersion` 是后悔药，先留好。

---

## 七、数据模型与契约

- **典范模型 = 场景 JSON**（scene：形状 / 位置 / 连线 / 分组 / 手绘笔触）。一块 board = 一条记录 + 一份 scene blob。三类 AgentCore 特有元素（`briefRegion` / `agentNode` / `artifactCard`）挂 `customData`，机制见 §六。
- **AI 读写原则**：**写**走**结构化运行时 ops**（add/move/connect/group），**不**走「让 AI 生成整张图片」，规避表达走工具的「4 失败点」（[工具与能力系统 §3.2](/docs/03-AI核心/工具与能力系统.md)）；**读**结构元素直接读 scene JSON（`getSceneElements`），手绘 / 截图区栅格化为图喂视觉模型（G6）。Excalidraw 侧落地见 §六。
- **`boards` 表（Postgres）**：`id` / `user_id` / `folder_id`（G3）/ `title` / `scene`（小场景内联 JSONB）/ `scene_blob_ref`（超阈值 S3 指针，G4）/ `version`（CAS）/ `created_at` / `updated_at`。
- **存储阈值（G4 ✅）**：scene JSON < **256 KB** 内联行内 JSONB；≥ 256 KB 落 S3、行内只存 `scene_blob_ref`。autosave 防抖 **~1.5s**；版本历史 = 保留**最近 K 次 autosave + 显式命名快照**（K 默认 20，实现细节可调）。复用 AgentCore 存储栈（[项目上下文](/.cursor/rules/project-context.mdc)：PostgreSQL / Redis / S3）。
- **REST 契约**：新增 `/v1/boards` CRUD，**照 [`folders.py`](/apps/server/agentcore/api/routes/folders.py) 范式**——`AuthUser` 作用域、非属主 404（IDOR-safe）、`repository` 模式、Pydantic schema 在 route 层转换。CAS 写法照 [`memory.py`](/apps/server/agentcore/api/routes/memory.py)：full text + `version` baseline，冲突回 `conflict` 不覆盖。
- **类型单一源**：route + schema 落地后 → 重生成 `pnpm -C packages/contract-rest-types gen`（`openapi-typescript apps/server/openapi.json`），白板前端 import 生成类型，不手写。
- **DB 迁移**：alembic 新 revision（照 `db/migrations/versions/` 现有范式）。
- **实时协作**（多人 / 多 Agent 同板）：按「无第二需求不预建」留缝，v1 可先单人 + AI，协作 sync 远期（§十二）。

---

## 八、后端接线（零新编排，守绊线）

白板**复用桌面客户端现有的** run 发起 + 事件流（进程内），不动 engine / loop / 调度（[dev-process 补丁绊线](/.cursor/rules/dev-process.mdc)）。

| 地基 | 复用方式 |
|---|---|
| 账号 / 认证 | **零接线**：白板是 desktop 内页面，同 origin 复用 `services/api.ts`（凭证式会话 + 401 refresh + CSRF），无新 CORS / 登录 gate |
| 发起团队 run（M3） | **进程内**复用桌面现有发起 AI run 的通道（`delegate` / `debate` / pipeline）：白板选区 → 组 brief → 起 run，**不写新编排** |
| 事件流 | 复用 SSE / 协议 fold，把 run 进度渲染成 `agentNode` 状态 |
| LLM / 读图 | 复用云推理代理 `/v1/inference`（含**视觉模型**读 `briefRegion`，G6） |
| 产物回贴 | 复用 `files` / 工作区；board ↔ 工作区加**导出接缝**（board → 图 / md / 产物入工作区），不反向破坏文本典范 |
| 存储 | Postgres + S3（§七） |
| 类型契约 | 复用 `@agentcore/contract-rest-types`（OpenAPI 单一源，[pnpm-workspace](/pnpm-workspace.yaml)） |
| desktop 接线 | **不新增 app**——`apps/desktop` 加 `WhiteboardPage` + 路由 + 侧栏入口 + `@excalidraw/excalidraw`；复用桌面构建 / 认证 / run / SSE |

> **接缝而非内核改造**：白板对 AgentCore 后端是**又一个发起 run + 读事件流的客户端**，不动引擎 / loop / 调度。一旦发现「为白板改编排器」→ 立即停、提根因（[dev-process 绊线](/.cursor/rules/dev-process.mdc)）。
>
> **协议 fold**：白板是新渲染面，组件层不进 conformance；`agentNode` 状态**直接复用桌面现有 run 事件 fold**（`conformanceFold`，已过 conformance），零新增 fold（[protocol-conformance](/.cursor/rules/protocol-conformance.mdc)）。

---

## 九、读图（G6）施工级设计 ⏳

> **状态**：本节是 G6 读图的施工级设计，**代码未建（⏳）**。**方案3（2026-06-26 定）**：先把**与视觉 provider 无关**的链路（栅格化 + briefRegion + board_read 通道）建到「插上即用」，**视觉解读节点抽象成 `VisionReader` 端口留空**——因 **DeepSeek V4 无多模态**（已确认），引第二个视觉 provider 属独立新依赖决策（成本 / 密钥 / 选型，[dev-process](/.cursor/rules/dev-process.mdc) AI 提案 → 人确认），按「无第二需求不预建」不顺手塞；待选定 provider（方案1）只实现一个 `VisionReader` 即补全。

**端到端链路**：人圈 `briefRegion`（手绘 / 截图）→ AI 在白板会话调 `board_read` → run 挂起、发 `board_read_required` → 桌面把该区域**栅格化为 PNG** 回填 → `board_read` 调 `VisionReader.read(png)` 得**文字解读** → 作为 tool 结果回主 agent → 主 agent 据此 `board_ops` 落元素。视觉是**一次性子调用**，**不**把主 ReAct 循环多模态化（§八 守绊线）。

### 九.1 briefRegion 元素（数据 · §六/§七 customData 延伸）
- 载体：Excalidraw `frame` 或 `rectangle`，挂 `customData = { kind: "briefRegion", schemaVersion: 1, note?: string }`（`schemaVersion` 后悔药，§六 已立）。
- 圈定：选中手绘 / 截图元素 → 命令栏「标为 brief」→ 宿主侧给选区套一个带上述 `customData` 的 region 元素。
- 持久化：随 scene blob 走现有 autosave CAS（§七），**无新表 / 新端点**。

### 九.2 桌面栅格化（provider 无关 · 可施工）
- 复用 Excalidraw `exportToBlob`（`@excalidraw/excalidraw`）：传 `elements` = briefRegion 内元素子集 + `appState` + `files`、`mimeType:"image/png"`，按区域 bbox 自动裁剪 → Blob → base64。
- 体积护栏：导出设 `maxWidthOrHeight`（如 1024）压尺寸；base64 入日志**必须截断**（[logging](/.cursor/rules/logging.mdc) 铁律：不落完整正文）。
- 落点：`WhiteboardCanvasPage` 与 applier 同层新增 `rasterizeRegion(regionId): Promise<{ pngBase64, w, h }>`，按 board id 注册进一个 reader 注册表（仿 `registerBoardApplier`），**只在画布打开时可用**。

### 九.3 board_read 通道（provider 无关 · 可施工 · 复刻 board_ops）
- 工具：`tools/builtin/board_read.py`（`board_read`），**仅白板会话可用**——同 `board_ops` 的 `ToolContext` 守卫（无通道则返回干净错误，不触碰画布）。入参：`region_id`（要读哪块 briefRegion）。
- 通道：仿 `BoardChannel`（`board/channel.py`）——`suspend(request_id, kind=CLIENT_TOOL, payload={region_id})` → `on_suspended` 发 `board_read_required` → 桌面栅格化回填 → future 落定；超时 / 画布未开 → 映射成**失败 tool 结果**（同 board_ops，不挂死回合）。
- 事件 + 契约：`runtime/events/board.py` 加 `board_read_required`；**与 `board_op_required` 同属 `client_tool` 交互事件**，沿用其契约重生成 + 两端处理范式（[protocol-conformance](/.cursor/rules/protocol-conformance.mdc)：是否进 fold 照 `board_op_required` 既有处理）。
- 桌面：`services/sse/handlers/board.ts` 加 `board_read_required` 分支 → 调 `rasterizeRegion` → `resolveInteraction(convId, requestId, { kind:"client_tool", ok, value:{ pngBase64, w, h } })`（仿 `boardOps.ts` 的 `performBoardOp`）。

### 九.4 视觉解读节点 = `VisionReader` 端口（⏳ 依赖未决）
- 端口（先定接口）：`class VisionReader(Protocol): async def read(self, png_b64: str, prompt: str) -> str`——输入 PNG + 提示，返回对图的**文字解读**。
- 接线：`board_read` 拿到 PNG 后 `text = await ctx.vision_reader.read(png, "把这张手绘/截图当作需求 brief，描述其结构与意图")`，把 `text` 作为 `ToolResult.output`（**纯文本**）回主 agent → 主 DeepSeek agent 据此 `board_ops`。
- **当前实现 = 无**：pipeline 注入 `vision_reader=None`；`board_read` 检测到 None 即返回「读图能力未配置」错误（仿 `board_ops` 的 `channel is None` 范式），**不假装、不挂起**。
- 补全（方案1，人拍板后）：只实现一个 `VisionReader`（如 `QwenVLReader` 走其多模态 `/chat/completions`，`image_url` 传 `data:image/png;base64,…`）+ 在 pipeline `build_turn_backend` 注入即可，§九.1–九.3 全不动——这就是「插上即用」。视觉子调用单独落账（`cost_events`，新 `scenario` 如 `board.vision`）。

### 验收
- **本期（方案3）**：briefRegion 可圈定并随 scene 持久化；白板会话调 `board_read` 能把选区栅格化成 PNG 回到后端；`vision_reader=None` 时返回明确「未配置」错误而非挂起。
- **待视觉 provider 落地（方案1）**：Hero——手绘 brief 被读懂、AI 据此摆元素端到端跑通（即 §十 M2 的读图验收项）。

---

## 十、里程碑任务拆解（带验收标准）

> 「AI 团队第一天就进」是产品要求，M1–M3 **同属 v1**；工程上仍按引擎→助手→团队分步交付，AI 不挪去 v2。每步「现有后端原语 + 白板新前端」，**后端零新基建**。

### M1 白板骨架 ✅ 已落地（依赖 G1/G2/G3/G4 ✅ 全部已满足）
- 任务：`apps/desktop` 加 `@excalidraw/excalidraw` → `WhiteboardPage`（全屏嵌 Excalidraw）→ 路由 + 侧栏「白板」入口 →（先 localStorage autosave 跑通）→ 落 `boards` 表 + `/v1/boards` + autosave 落库。
- **验收**：侧栏「白板」可进；能画 / 平移 / 缩放；建 / 存 / 开 board；刷新不丢；autosave 冲突回 `conflict` 不覆盖。
- **现状 ✅**：`boards` 表 + 迁移 `b1d7f3c9a2e4`、`/v1/boards` CRUD、白板列表页 + 画布页 + 路由 + 侧栏入口均已落地；autosave 1.5s 防抖 + CAS `conflict` 不覆盖已实现（→ 见代码 `apps/desktop/src/renderer/pages/WhiteboardCanvasPage.tsx`、`apps/server/agentcore/api/routes/boards.py`）。

### M2 AI 助手进板 ⚠️ 部分落地（结构化 ops ✅ / 读图 G6 ⏳）
- 任务：AI ops 适配器（add/move/connect/group → skeleton → updateScene）+ 布局助手；接视觉模型读 `briefRegion`；一个 AI 操作入口（选区 →「帮我整理 / 生成结构」）。
- **验收**：选区 → AI 加便签 / 连线 / 排流程可见；手绘 brief 能被读懂并据此摆元素。
- **现状 ✅ 结构化 ops**：`board_ops` 工具 + `BoardChannel`（run 挂起 → `board_op_required` 事件 → 桌面 applier：convert → updateScene → CAS 保存 → resolve 回执）+ 老板命令栏 + 整理选区 + resume 重绑，全链路通（→ 见代码 `apps/server/agentcore/tools/builtin/board_ops.py`、`apps/server/agentcore/board/channel.py`）。
- **缺口 ⏳ 读图（G6）**：「整理选区」目前走 `describeSelection` **文字描述**喂模型，**不是**选区栅格化喂视觉模型；`briefRegion` / 手绘读图链路未建（施工级设计见 §九，视觉节点待 provider 决策）。

### M3 AI 团队照白板干活 ⏳ 未落地（依赖 §八 接入点）
- 任务：白板选区 →「让团队照这实现」→ 发起 run → 进度回贴 `agentNode` → 产物回贴 `artifactCard`。
- **验收**：Hero 故事端到端跑通；产物可 `@` 回工作区。
- **现状 ⏳**：`agentNode` / `artifactCard` / `briefRegion` / `customData` 全仓库仅本文提及，代码零实现；施工级设计待写。

---

## 十一、风险与护栏

| 风险 | 护栏 |
|---|---|
| 引擎授权 / 原生节点取舍 | v1 走 stock Excalidraw（$0）规避授权费；原生 Agent 节点刚需时再 tldraw（付费）/ Fork（merge 税）（§五） |
| 「又一个 Miro」（无差异） | 守住 Hero = AI 团队；纯白板部分够用即可，不在通用功能上卷 |
| 范围蔓延 / 重复造轮子 | 不把 `ConversationCanvas`、mermaid、文件列表搬进来重做（§一已界定重叠） |
| AI 在空间画布的「4 失败点」回归 | AI 摆元素走**结构化运行时 ops**，绝不强行让 AI「画」整图（§七） |
| scene 迁移坑 | `customData.schemaVersion` 先留好（§六） |
| 并发写 / 协作 | 协作 = 自己人同板，走后端 sync（远期）；即便单人，人与 AI 也并发写板 → 定 `id→element` 合并策略 |
| 空间 JSON 与文件体系割裂 | 独立产品故合规；若需互通，加**导出接缝**（board → 导出图 / md / 产物入工作区），不反向破坏文本典范 |
| 为白板改内核 | [dev-process 绊线](/.cursor/rules/dev-process.mdc)：即停、提根因重设计 |

---

## 十二、待议

> 设计文档原列的「渲染引擎 / 落地形态 / board↔folder / 白板存储 / 读图通道」**均已在 §三 拍板**（G1/G2/G3/G4/G6），不再是待议；下表只留真正未定项。

| 议题 | 选项 |
|---|---|
| 实时协作（多人 / 多 Agent 同板） | v1 单人 + AI vs v1 即上 sync（倾向前者，留缝不预建） |
| M3 run 接入点 | 复用现有发起 AI run 通道，**确切入口**待 M3 开工时定（§八） |

> **进度（2026-06-25 核代码）**：产品方向 + 全部 gate 已定（真白板 + 做进 desktop 页面 + AI 团队第一天就进；引擎 stock Excalidraw）。**M1 已完成**（Excalidraw + `WhiteboardPage` + 路由 + 侧栏入口；`boards` 表 + alembic 迁移 `b1d7f3c9a2e4` + `/v1/boards` + autosave 落库 + 契约已生成）。**M2 结构化 ops 已完成**（`board_ops` + `BoardChannel` + 桌面 applier + 命令栏 + 整理选区 + resume 重绑）。**剩余未建**：M2 读图（G6：选区栅格化 → 视觉模型 → `briefRegion`）+ M3（团队照白板：`agentNode` / `artifactCard` 回贴）。待 M3 也落地后，页面 / 契约迁入 `04-前端` / `02-架构`，本文退役。
