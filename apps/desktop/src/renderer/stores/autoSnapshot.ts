import { create } from "zustand";

/**
 * Live UX for post-turn cloud auto-backup (axis-3).
 * EPHEMERAL SSE drives this — reload clears the banner by design.
 *
 * 「打开快照面板」不再走 store：快照已并入常驻的「改动」tab，
 * 失败提示直接 `showChanges()` 即可，无需跨组件的一次性打开请求。
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
