import { api } from "@/services/api";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import type { components } from "@/types/api.generated";

type PausedTurnListResponse = components["schemas"]["PausedTurnListResponse"];
type PausedTurnSummary = components["schemas"]["PausedTurnSummary"];

/** List a conversation's durably-paused turns awaiting resume (结构化挂起 2b). */
export async function listPausedTurns(
  conversationId: string,
): Promise<PausedTurnSummary[]> {
  const res = await api.get<PausedTurnListResponse>(
    `/v1/conversations/${conversationId}/paused`,
  );
  return res.data ?? [];
}

/**
 * Fetch a conversation's paused turns into the store (best-effort).
 *
 * Called on conversation reopen so a turn that paused at a plan_review checkpoint
 * then disconnected surfaces a resume card above the composer. A lookup failure is
 * swallowed — it must never block opening a conversation (the turn stays
 * recoverable on a later reopen).
 */
export async function loadPausedTurns(conversationId: string): Promise<void> {
  try {
    const data = await listPausedTurns(conversationId);
    usePausedTurnStore.getState().setForConversation(conversationId, data);
  } catch {
    /* best-effort: never block reopening on a paused-turn lookup */
  }
}
