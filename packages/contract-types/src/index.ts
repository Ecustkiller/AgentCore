// @agentcore/contract-types — 桌面/手机两端共享的契约类型单一源（手机端落地设计 §六 支柱2）。
//
// 现承载 SSE 事件判别联合 + payload 类型（从 apps/desktop/src/renderer/types/events.ts
// 提取）。两端 fold 都 import 这里的 SSEEventType 并 `switch` + assertNever 穷尽——
// 后端加事件类型 → 这里加一支 → 两端编译失败直到处理（最便宜的漂移绊线）。
//
// ✅ 桌面端已并入 workspace 并迁移：其 types/events.ts 改为 `export type *` 透传本包 +
// 仅保留 4 个桌面独有的工具富渲染类型（手机精简端不需要）。本包是两端事件类型的单一源。
export * from "./events";
