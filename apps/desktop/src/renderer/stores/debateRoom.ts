import { create } from "zustand";

/**
 * Bridge state for the 辩论裁判台 HUD (裁决台 + 记分 + 掌舵), hosted as the side
 * panel's fixed 「裁判台」 tab ({@link import("../components/layout/SidePanel")})
 * while a debate room is focused — parallel to the 「工作区」 home tab, not stacked
 * above run-detail tabs (前端UX设计.md §4.3 · §十).
 *
 * Turn focus is a canvas concept, so {@link
 * import("../components/graph/CanvasZoomedTurn").CanvasZoomedTurn} publishes the
 * focused debate room here (`target`) whenever it is showing the 群聊 room view; the
 * region — rendered by the side panel via {@link
 * import("../components/chat/debate/DebateHud").useDebateHud} — reads it and derives
 * everything else live from the execution store (single data source, no snapshot
 * copy). `target` is null whenever no debate room is zoomed in, so the HUD only
 * surfaces while the boss is actually watching a debate.
 *
 * `collapsed` is the region's own fold state: session-level (not persisted) and
 * re-armed (re-expanded) on room entry / a fresh steering boundary, so a decision the
 * boss must make is never left buried.
 */
export interface DebateRoomTarget {
  /** The focused debate turn (assistant message id owning the execution). */
  turnId: string;
  /** Conversation id for the steering decision round-trip (null → 掌舵 read-only). */
  conversationId: string | null;
  /** Focused turn is live & non-terminal → steering is actionable (决策卡 transport-only). */
  interactive: boolean;
}

interface DebateRoomState {
  /** Focused debate room being viewed; null = no debate room zoomed in. */
  target: DebateRoomTarget | null;
  /** HUD region folded to its header strip. Not persisted. */
  collapsed: boolean;
  setTarget: (target: DebateRoomTarget | null) => void;
  setCollapsed: (collapsed: boolean) => void;
}

export const useDebateRoomStore = create<DebateRoomState>((set) => ({
  target: null,
  collapsed: false,
  setTarget: (target) => set({ target }),
  setCollapsed: (collapsed) => set({ collapsed }),
}));
