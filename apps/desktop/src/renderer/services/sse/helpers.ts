import { getRuntime, lastAssistantMessageId } from "@/stores/conversation";

/** Resolve the assistant message id for the live turn's execution slot (§9.3). */
export function execMessageId(conversationId: string): string | null {
  return lastAssistantMessageId(getRuntime(conversationId).messages);
}
