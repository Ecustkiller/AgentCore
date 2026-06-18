// @agentcore/contract-types — 桌面/手机两端共享的契约类型单一源（手机端落地设计 §六 支柱2）。
//
// 现承载 SSE 事件判别联合 + payload 类型（从 apps/desktop/src/renderer/types/events.ts
// 提取）。两端 fold 都 import 这里的 SSEEventType 并 `switch` + assertNever 穷尽——
// 后端加事件类型 → 这里加一支 → 两端编译失败直到处理（最便宜的漂移绊线）。
//
// ⏳ 桌面端仍用其本地副本 types/events.ts；其 import 迁移到本包是后续任务（需 desktop
// 先并入 workspace）。在那之前两份须保持一致；本包是新代码（mobile / conformance）的源。
export * from "./events";
