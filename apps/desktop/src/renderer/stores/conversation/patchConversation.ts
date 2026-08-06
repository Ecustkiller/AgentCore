import { DRAFT_KEY, EMPTY_RUNTIME } from "./runtime";
import type { ConversationSet, PatchConversation } from "./state";

/** Shared byId-slice patcher used by message-window / stream / turn action axes. */
export function createPatchConversation(
  set: ConversationSet,
): PatchConversation {
  return (conversationId, update) =>
    set((state) => {
      const key = conversationId ?? state.currentConversationId ?? DRAFT_KEY;
      const cur = state.byId[key] ?? EMPTY_RUNTIME;
      const patch = update(cur);
      if (!patch) return {};
      return { byId: { ...state.byId, [key]: { ...cur, ...patch } } };
    });
}
