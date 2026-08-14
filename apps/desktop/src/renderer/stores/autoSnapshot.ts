import { create } from "zustand";

/**
 * Live UX for post-turn cloud auto-backup (axis-3).
 * EPHEMERAL SSE drives this — reload clears the banner by design.
 *
 * `failedByConversation` feeds the changes-panel banner (copy lives elsewhere).
 * Failure toast does not open that tab or treat it as a version workbench.
 */
type AutoSnapshotState = {
  /** Conversations whose latest auto-backup attempt failed. */
  failedByConversation: Record<string, true>;
  markFailed: (conversationId: string) => void;
  clearFailed: (conversationId: string) => void;
};

export const useAutoSnapshotStore = create<AutoSnapshotState>((set) => ({
  failedByConversation: {},
  markFailed: (conversationId) =>
    set((s) => ({
      failedByConversation: {
        ...s.failedByConversation,
        [conversationId]: true,
      },
    })),
  clearFailed: (conversationId) =>
    set((s) => {
      if (!s.failedByConversation[conversationId]) return s;
      const next = { ...s.failedByConversation };
      delete next[conversationId];
      return { failedByConversation: next };
    }),
}));
