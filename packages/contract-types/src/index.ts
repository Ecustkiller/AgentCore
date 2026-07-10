// @agentcore/contract-types — 桌面/手机两端共享的契约类型单一源（前端技术与架构 §十二）.
//
// SSE 事件名：后端 EventType → eventTypes.generated.ts（`pnpm gen:types`）。
// SSE payload：后端 payloads/*.py → events.generated.ts。REST DTO：见 @agentcore/contract-rest-types。
export * from "./errorCodes";
export * from "./events";
