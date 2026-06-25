import { create } from "zustand";

/**
 * Bridge + UI state for the 指挥台 (war-room command region), now hosted INSIDE the
 * unified right side panel (前端UX设计.md §6.2 · §十) rather than as a second dock.
 *
 * Turn focus is a canvas concept, so {@link
 * import("../components/graph/ConversationCanvas")} publishes two things here:
 *  - `active`: the canvas view is mounted, so the region MAY surface (chat mode keeps
 *    decisions inline in the message stream, so it stays false there);
 *  - `focusedMessageId`: the focused team turn whose turn-level cards (ask_user /
 *    plan_review / 工作者上报 / 逐轮辩论) render — null when no team turn is focused
 *    (conversation-level approval / resume / 救火 / 后台云端任务 still surface).
 *
 * The region — rendered by {@link import("../components/layout/SidePanel")} — reads
 * these and derives everything else live from the execution / approval / resume /
 * background stores (single data source, no snapshot copy). `collapsed` is the
 * region's own fold state: session-level (not persisted) and re-armed (re-expanded)
 * on a new actionable item or a focus switch, so a fresh decision is never buried.
 */
interface CommandPanelState {
  /** Canvas view is mounted — gates the region (chat mode keeps decisions inline). */
  active: boolean;
  /** Focused team turn's assistant message id (turn-level card scope); null = none. */
  focusedMessageId: string | null;
  /** Region folded to its header strip (the「待你拍板」badge still shows). Not persisted. */
  collapsed: boolean;
  /** Canvas mount/unmount toggles this; leaving canvas also clears the focus. */
  setActive: (active: boolean) => void;
  setFocused: (messageId: string | null) => void;
  setCollapsed: (collapsed: boolean) => void;
}

export const useCommandPanelStore = create<CommandPanelState>((set) => ({
  active: false,
  focusedMessageId: null,
  collapsed: false,
  setActive: (active) =>
    set(active ? { active: true } : { active: false, focusedMessageId: null }),
  setFocused: (focusedMessageId) => set({ focusedMessageId }),
  setCollapsed: (collapsed) => set({ collapsed }),
}));
