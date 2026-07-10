import { getRuntime, lastAssistantProjectionId } from "@/stores/conversation";

/** Resolve the live turn's execution slot key (§9.3): `serverMessageId ?? id`. */
export function execMessageId(conversationId: string): string | null {
  return lastAssistantProjectionId(getRuntime(conversationId).messages);
}
