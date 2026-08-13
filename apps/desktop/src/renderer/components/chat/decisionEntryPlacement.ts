import { createContext, useContext } from "react";

/**
 * 拍板卡（ResumePrompt）相对时间线标记的方位。
 *
 * 方案 C「一个焦点 + 一个入口」把冷交互挂起的完整操作面统一收到拍板卡，时间线上只留
 * 一行 {@link import("./PendingDecisionMarker").PendingDecisionMarker} 指路。指路要指对：
 *
 * - 聊天面：MessageList 在上、决策区贴着输入框在下 → `below`（默认）。
 * - 画布指挥台（{@link import("../graph/CanvasDecisionPanel").CommandPanelBody}）：
 *   装配顺序相反，`ConversationDecisionPrompts` 在最上、卡片列在其下 → `above`。
 *
 * 用 context 而非 prop：标记藏在 PlanReviewCard / TeamPreviewCard 里，而这两张卡由
 * `registryUi` 的时间线渲染表按 processKind 装配，逐层透传 prop 会污染那张表。
 */
export type DecisionEntryPlacement = "below" | "above";

export const DecisionEntryPlacementContext =
  createContext<DecisionEntryPlacement>("below");

export function useDecisionEntryPlacement(): DecisionEntryPlacement {
  return useContext(DecisionEntryPlacementContext);
}

export function decisionEntryHint(placement: DecisionEntryPlacement): string {
  return placement === "above" ? "入口在上方拍板卡" : "入口在下方拍板卡";
}
