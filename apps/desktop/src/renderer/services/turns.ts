import {
  type OutgoingAttachment,
  describeStreamError,
  regenerateConversation,
  streamConversation,
} from "@/services/streamConversation";
import { useConversationStore } from "@/stores/conversation";

/** The user's explicit stop (abort button) — never surfaced as an error. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Re-run a turn from an existing (persisted) user message.
 *
 * Backs the message-level regenerate / edit-and-resend actions, and the retry
 * path once a send has been persisted. Drops everything after the user message,
 * opens a fresh assistant bubble, then streams the new reply; the backend
 * truncates the same range so persisted history stays consistent. On a transport
 * failure it raises a retry banner that re-runs the same regenerate.
 */
export async function runRegenerate(
  userMessageId: string,
  content?: string,
): Promise<void> {
  const store = useConversationStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId || store.isGenerating) return;

  store.clearError();
  store.truncateAfter(userMessageId);
  store.createAssistantMessage();

  const ac = new AbortController();
  store.setAbort(ac);
  try {
    await regenerateConversation({
      conversationId,
      messageId: userMessageId,
      content,
      signal: ac.signal,
    });
  } catch (err) {
    if (isAbort(err)) return;
    const s = useConversationStore.getState();
    if (s.isGenerating) s.finalizeLastMessage();
    const msg = describeStreamError(err);
    if (msg) s.setError(msg, () => void runRegenerate(userMessageId, content));
  } finally {
    useConversationStore.getState().setAbort(null);
  }
}

export interface SendTurnSpec {
  conversationId: string;
  content: string;
  attachments: OutgoingAttachment[];
  /** Optimistic client id of the user bubble (already added to the store).
   * After `turn_saved` reconciles it, this id is gone — the signal that the
   * turn is persisted and a retry must regenerate rather than resend. */
  optimisticUserId: string;
}

/**
 * Stream a freshly-sent user message, with a self-reinstalling retry.
 *
 * The user bubble is added optimistically by the caller before this runs. On a
 * transport failure it raises a banner whose retry re-invokes this function.
 * The retry is persistence-aware: once the backend has saved the turn (its
 * `turn_saved` swaps the optimistic id for the real one), resending would
 * duplicate the user turn, so we regenerate from the saved message instead.
 */
export async function sendTurn(spec: SendTurnSpec): Promise<void> {
  const { conversationId, content, attachments, optimisticUserId } = spec;
  const store = useConversationStore.getState();
  store.clearError();

  // Persisted already? Then the optimistic id was swapped out — regenerate from
  // the saved user message rather than resending (which would duplicate it).
  const stillOptimistic = store.messages.some((m) => m.id === optimisticUserId);
  if (!stillOptimistic) {
    const lastUser = [...store.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUser) {
      await runRegenerate(lastUser.id);
      return;
    }
  }

  // Fresh attempt: drop any partial assistant bubble left by a failed try
  // (no-op on the first send, where the user bubble is already last).
  store.truncateAfter(optimisticUserId);

  const ac = new AbortController();
  store.setAbort(ac);
  try {
    await streamConversation({
      conversationId,
      content,
      attachments,
      signal: ac.signal,
    });
  } catch (err) {
    if (isAbort(err)) return;
    const s = useConversationStore.getState();
    if (s.isGenerating) s.finalizeLastMessage();
    const msg = describeStreamError(err);
    if (msg) s.setError(msg, () => void sendTurn(spec));
  } finally {
    useConversationStore.getState().setAbort(null);
  }
}
