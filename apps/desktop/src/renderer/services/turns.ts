import {
  type OutgoingAttachment,
  describeStreamError,
  regenerateConversation,
  streamConversation,
} from "@/services/streamConversation";
import { useApprovalStore } from "@/stores/approvals";
import { type Message, useConversationStore } from "@/stores/conversation";

/** The user's explicit stop (abort button) — never surfaced as an error. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** The most recent user message in the open conversation, or null. Backs the
 * task card's retry / adjust-instruction / replan actions. */
export function lastUserMessage(): Message | null {
  const msgs = useConversationStore.getState().messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i];
  }
  return null;
}

/** Id of {@link lastUserMessage}, or null. */
export function lastUserMessageId(): string | null {
  return lastUserMessage()?.id ?? null;
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
  store.bumpConversation(conversationId);
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
    // A failed turn never delivers `approval_resolved`; drop any paused prompt.
    useApprovalStore.getState().clear();
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

  // Snapshot the pre-bump position so we can undo the optimistic bump if the
  // send fails before the server ever persisted the turn.
  const beforeBump = store.conversations;
  const origIndex = beforeBump.findIndex((c) => c.id === conversationId);
  const origUpdatedAt = origIndex >= 0 ? beforeBump[origIndex].updatedAt : null;
  store.bumpConversation(conversationId);

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
    // A failed turn never delivers `approval_resolved`; drop any paused prompt.
    useApprovalStore.getState().clear();
    // If the turn never persisted (no `turn_saved` reconciled the optimistic
    // id), the server order never changed — undo the optimistic bump.
    const notPersisted = s.messages.some((m) => m.id === optimisticUserId);
    if (notPersisted && origIndex >= 0 && origUpdatedAt !== null) {
      s.restoreConversation(conversationId, origIndex, origUpdatedAt);
    }
    const msg = describeStreamError(err);
    if (msg) s.setError(msg, () => void sendTurn(spec));
  } finally {
    useConversationStore.getState().setAbort(null);
  }
}
