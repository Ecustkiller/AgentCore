import {
  getRuntime,
  reusableSendAssistantId,
  useConversationStore,
} from "@/stores/conversation";

/**
 * One send → one assistant bubble. Composer already painted Thinking; keep
 * that id. Truncate + create only when a failed try left a dirty leftover.
 */
export function ensureSendAssistantPlaceholder(
  conversationId: string,
  optimisticUserId: string,
): void {
  const store = useConversationStore.getState();
  const keepId = reusableSendAssistantId(
    getRuntime(conversationId).messages,
    optimisticUserId,
  );
  if (keepId) {
    const rt = getRuntime(conversationId);
    const existing = rt.messages.find((m) => m.id === keepId);
    if (!existing) {
      store.createAssistantMessage(conversationId);
      return;
    }
    if (!existing.isStreaming) {
      store.updateMessage(keepId, { isStreaming: true }, conversationId);
    }
    if (!rt.isGenerating) {
      store.setGenerating(true, conversationId);
    }
    if (rt.waitingForWorkspaceLock) {
      store.setWaitingForWorkspaceLock(false, conversationId);
    }
    if (rt.waitingForDeskProvision) {
      store.setWaitingForDeskProvision(false, conversationId);
    }
    return;
  }
  store.truncateAfter(optimisticUserId, conversationId);
  store.createAssistantMessage(conversationId);
}
