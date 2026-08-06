import { useCommandPanelStore } from "../commandPanel";
import { useConversationStore } from "../conversation";
import type { SidePanelGet, SidePanelSet, SidePanelState } from "./types";

/** Record dismiss for whichever auto-surface context is currently active. */
export function recordActiveContextDismiss(
  get: () => Pick<SidePanelState, "dismissAutoSurface">,
): void {
  const commandActive = useCommandPanelStore.getState().active;
  const conversationId = useConversationStore.getState().currentConversationId;
  if (commandActive && conversationId) {
    get().dismissAutoSurface(`command:${conversationId}`);
  }
}

type AutoSurfaceActions = Pick<
  SidePanelState,
  | "dismissAutoSurface"
  | "isAutoSurfaceDismissed"
  | "clearAutoSurfaceDismiss"
  | "incrementPendingBadge"
>;

/** Auto-surface dismiss memory + pending badge. */
export function createAutoSurfaceActions(
  set: SidePanelSet,
  get: SidePanelGet,
): AutoSurfaceActions {
  return {
    dismissAutoSurface: (contextId) => {
      set((s) => {
        const dismissedContexts = new Set(s.dismissedContexts);
        dismissedContexts.add(contextId);
        return { dismissedContexts };
      });
    },

    isAutoSurfaceDismissed: (contextId) =>
      get().dismissedContexts.has(contextId),

    clearAutoSurfaceDismiss: (contextId) => {
      set((s) => {
        if (!s.dismissedContexts.has(contextId)) return s;
        const dismissedContexts = new Set(s.dismissedContexts);
        dismissedContexts.delete(contextId);
        return { dismissedContexts };
      });
    },

    incrementPendingBadge: () =>
      set((s) => ({ pendingBadge: s.pendingBadge + 1 })),
  };
}
