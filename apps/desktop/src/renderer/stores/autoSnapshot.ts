import { create } from "zustand";

/**
 * Live UX for post-turn cloud auto-backup (axis-3).
 * EPHEMERAL SSE drives this — reload clears the banner by design.
 */
type AutoSnapshotState = {
  /** Conversations whose latest auto-backup attempt failed. */
  failedByConversation: Record<string, true>;
  /** When set, WorkspaceMode should open the snapshots slide-over for this id. */
  openSnapshotsFor: string | null;
  markFailed: (conversationId: string) => void;
  clearFailed: (conversationId: string) => void;
  requestOpenSnapshots: (conversationId: string) => void;
  consumeOpenSnapshots: (conversationId: string) => void;
};

export const useAutoSnapshotStore = create<AutoSnapshotState>((set, get) => ({
  failedByConversation: {},
  openSnapshotsFor: null,
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
  requestOpenSnapshots: (conversationId) =>
    set({ openSnapshotsFor: conversationId }),
  consumeOpenSnapshots: (conversationId) => {
    if (get().openSnapshotsFor !== conversationId) return;
    set({ openSnapshotsFor: null });
  },
}));
