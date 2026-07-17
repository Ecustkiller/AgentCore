# 桌面端 UI 交互自动化提案

> 🗂️ 状态：需求已拍板（2026-07-16）——目的两步走（AI 自检回路 → 门禁）、离线确定性驱动、桌面端优先；实施方案经**双路审计修订**（2026-07-16，主 Agent + 独立子代理各一路，结论已并入正文，过程见会话记录），**待产品负责人确认**。
>
> 现状事实基线：预览/截图机制 as-built 见 [前端技术与架构 §12.3](/docs/04-前端/前端技术与架构.md)、[`frontend-preview.mdc`](/.cursor/rules/frontend-preview.mdc)。

## 一、问题与现状

桌面端自检基建「看得见、点不动」：

- **已完善（视觉/渲染层）**：`#/preview` 用真实 `dispatchSSEEvent` 回放 conformance 向量、`pnpm shoot` 家族无头截图、CI 渲染冒烟、`shoot:graph-probe` 视口数值探针；组件级 vitest；协议层 `pnpm conformance` 双端 fold 契约。
- **缺口（交互/功能层）**：没有可维护的「操作 → 断言」自动化。AI 改完前端能自检「渲染出来长什么样」，不能自检「点击之后行为对不对」（发消息、点协作图、点审批卡）。
- 现有交互类资产均不可当自检回路：`smoke-demo-tape.mjs` / `smoke:webapp`（依赖活后端）、`packaged-smoke.mjs`（只验打包壳启动）。（原 throwaway `e2e/ui-test.mjs` 已删。）
- **根因缺口**：网络/回合驱动面没有离线替身——`#/preview` 是单向 fold 回放（跳过网络），离线壳下发消息打不到任何后端、点交互卡不会产生后续事件，用户流程无法闭环。

## 二、已拍板需求（2026-07-16）

1. **目的两步走**：先建 AI 开发时自检回路（改完交互代码自己验证），稳定后挂回归门禁。
2. **离线确定性**：不依赖真实 LLM、不依赖活后端——同一测试永远同一结果，AI 与门禁才敢信任。
3. **范围**：桌面端优先（mobile/admin 暂不做，设计预留复用）。
4. 先提案后动手。

## 三、方案概述（待确认）

核心：新增一个**向量剧本 mock 后端**——轻量 Node HTTP/SSE 服务，REST 只实现最小端点面，SSE 推送的事件体来自**真实 conformance 向量按剧本切段**；Playwright 正式测试套件驱动真实渲染层完成用户操作并断言。

```
Playwright spec（操作 + 断言）
   ↓ 驱动
真实渲染层（webapp 壳 main.webapp.tsx：真实 AuthGate + cookie；browserStubs 垫 Electron 面）
   ↓ 真实 HTTP / SSE 消费链路（VITE_API_URL 指向 mock）
向量剧本 mock 后端（最小 REST + SSE 推流；事件序列 = conformance 向量切段）
```

### 设计要点

- **D1 · mock 落在网络接缝，不落组件面**：渲染态仍由真实 `dispatchSSEEvent` fold 真实向量产生。与既有否决决策（Storybook 平行链、手写 mock AI 态）不冲突——mock 的是**传输**，不是状态；且比 `#/preview` 多覆盖一段生产代码（HTTP/SSE 拉流、解析、消费层）。
- **D2 · 壳用 webapp（`main.webapp.tsx`），不用 dev:web**（审计修订）：`main.web.tsx` 硬编码 `__WEB_PREVIEW__`，连带 AuthGate 整体旁路、健康监控关闭、uiStorage 内存化、capabilities 降级——渲染冒烟无妨，交互保真不足。webapp 壳保留真实 auth/cookie 链路（`smoke-webapp.mjs` 已验证「webapp + 外置 API」模式），mock 提供 auth 端点并自管跨源（CORS + cookie 回写 + CSRF 头透传）。接缝已核实干净：`BASE_URL = VITE_API_URL ?? localhost:8000`，无 Vite proxy 依赖。
- **D3 · 独立 Node mock 服务，而非 Playwright `route.fulfill`**：SSE 需要增量推送（流式中间态）和**交互触发续流**，`route.fulfill` 一次性返回整体 body，两者都做不到。mock 须对齐生产 SSE 语义：`event:`/`data:`/`id:` 帧格式、长等待期心跳（服务端 15s `: ping`，客户端 60s idle 即断流）、`Last-Event-ID` 重连回放（首批用例可弱化，实现时对齐更稳）。
- **D4 · 剧本 = 向量切段编排**，两条硬约束（审计修订）：
  - **只用带交互边界的向量**：约 86 条向量中仅约 26 条含「等用户」中断点（`*_required` / paused / checkpoint 类）；剧本必须钉具体向量名，禁止对无边界向量随意切段。事件序列必须来自后端导出的真实向量，**禁止手写事件**。
  - **提交面按 kind 分叉**：审批类 = `POST .../interactions/{id}`，同流续推后续段；开工/计划复核/checkpoint 类 = `POST .../messages/{id}/resume`，冷续新 SSE 流。mock 剧本状态机须区分两条路径。
- **D5 · REST 契约防漂移**：SSE 事件体由真实向量天然钉住，但 REST 响应是手写 mock——必须用 `@agentcore/contract-rest-types`（OpenAPI 生成，桌面已依赖）做类型约束，typecheck 钉住形状。
- **D6 · 正式 Playwright 套件**：`apps/desktop/e2e/` 放 `*.spec.ts`，`pnpm e2e` 一键编排（起 Vite webapp + mock 后端 + 跑 spec），失败自动留截图 + trace 供 AI 读图定位。新增 devDependency `@playwright/test`，**与现有 `playwright` 钉同一版本**（共享浏览器缓存，防 lockfile 拆出两套 chromium）。真实全栈验收由 demo-tape / `smoke:webapp` 承担。
- **D7 · 断言口径为行为**：元素出现、路由跳转、请求发出、状态推进；不做像素基线 diff（视觉核对仍归 shoot 读图体系）。

## 四、首批用例（4 条）

| # | 流程 | 剧本向量（同族可换） | 钉住什么 |
|---|---|---|---|
| 1 | 草稿首发：输入 → 发送 → URL 跳 `#/conversations/:id` → 流式正文出现并完成 | 单聊基础向量 | 历史回归：MessageInput unmount 中断 POST |
| 2 | 多 Agent 派单：发送 → 任务卡出现 → 点「查看协作图」→ 图节点渲染 → 返回 | `multi_agent_delegate` | 任务卡/协作图交互入口 |
| 3 | 交互卡闭环（双提交面）：审批卡点击 → 断言 `POST interactions` → 同流续段推进；开工卡点击 → 断言 `POST resume` → 新流推进 | `approval_resolved_continue`、`team_preview_resolved_continue` | 现在完全测不到的「交互后回合推进」，两条提交路径都要 |
| 4 | 新建对话与会话切换：新建 → 草稿态 → 再发送 | 复用用例 1 | `switchConversation(null)` 一族回归 |

阶段一稳定后的**用例池**（非首批）：冷 resume / 断线重挂（`GET .../stream` + `Last-Event-ID`）、停止回合（`POST .../stop`）、非阻塞提问（`question_posted`）与阻塞卡差异。

## 五、mock 最小 REST 端点面

从代码钉死（审计核实），实现期不再另行盘点：

| 用途 | 端点 |
|---|---|
| 探活（webapp AuthGate） | `GET /readyz` |
| Auth | `GET /v1/auth/me`、`POST /v1/auth/login`、（可选）`POST /v1/auth/refresh` |
| 会话列表/切换 | `GET /v1/conversations`、`GET /v1/conversations/grouped` |
| 新建会话（用例 1/4） | `POST /v1/conversations` |
| 发送 + SSE（用例 1/2/4） | `POST /v1/conversations/{id}/messages`（`Accept: text/event-stream`） |
| 审批提交（用例 3） | `POST /v1/conversations/{id}/interactions/{interaction_id}` |
| 开工/checkpoint 续跑（用例 3） | `POST .../messages/{message_id}/resume` |
| 重连（用例池） | `GET .../stream` |

## 六、分期与验收

**阶段一 · AI 自检回路**：mock 后端 + `pnpm e2e` + 首批 4 用例。

- 验收：断网可跑；全绿且连跑 5 次零 flake；单次全量 ≤3 分钟；失败产物（截图 + trace）足以让 AI 不开应用即定位。
- 落地后同步纪律：`frontend-preview.mdc` 增补「改交互相关代码 → `pnpm e2e`」，与「改渲染 → `pnpm shoot`」并列。

**阶段二 · 回归门禁**：阶段一稳定运行一段时间后，挂入 `ci.yml` frontend job（与 shoot 同位置）并纳入 `release:gate`。按 GHA 无配额现状，实际兜底靠 `release:gate` 本地一键，CI 保持同构。

## 七、范围外

- mobile webapp / admin 端（mock 层与剧本格式设计时预留复用，跨端契约同源）。
- 真实全栈 E2E（真后端 + 真 LLM）：不进自检回路与门禁，人工验收继续用 demo-tape。
- **Electron 主进程 IPC / 打包壳行为**：web 壳下 `browserStubs` 垫掉，测不到（打包壳启动由 `packaged-smoke.mjs` 兜）。
- **本地引擎 sidecar 回合路径**：web 壳 `hasLocalEngine()` 恒 false，sidecar 分支交互（如 sidecar 侧 respond/resume）本套测不到。
- **realtime 通道**（`/v1/realtime` 跨对话通知）：非首批，防误扩。
- 视觉像素回归基线、AI 探索式测试（computer use）。

## 八、留给实现期的决策（不阻塞本提案确认）

- 向量切段落点：导出期标注段边界 vs mock 运行期按事件类型识别边界。
- CSRF 处理细节（mock 直接放行 vs 完整模拟发放/校验）。
