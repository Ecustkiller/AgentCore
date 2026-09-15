import { logEvent } from "@/lib/log";
import {
  getRuntime,
  reusableSendAssistantId,
  useConversationStore,
} from "@/stores/conversation";

function logAssistantPlaceholder(
  conversationId: string,
  optimisticUserId: string,
  action: "reuse" | "mint",
  assistantId: string,
): void {
  logEvent("info", "send.assistant_placeholder", {
    conversation_id: conversationId,
    optimistic_user_id: optimisticUserId,
    assistant_id: assistantId,
    action,
  });
}

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
      const assistantId = store.createAssistantMessage(conversationId);
      logAssistantPlaceholder(
        conversationId,
        optimisticUserId,
        "mint",
        assistantId,
      );
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
    logAssistantPlaceholder(conversationId, optimisticUserId, "reuse", keepId);
    return;
  }
  store.truncateAfter(optimisticUserId, conversationId);
  const assistantId = store.createAssistantMessage(conversationId);
  logAssistantPlaceholder(
    conversationId,
    optimisticUserId,
    "mint",
    assistantId,
  );
}
