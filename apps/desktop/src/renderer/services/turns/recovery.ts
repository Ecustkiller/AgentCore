import { describeStreamError, streamErrorAction } from "@/lib/errors";
import { loadLatestWindow } from "@/services/messages";
import { attachConversation } from "@/services/streamConversation";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import {
  RECONNECT_BANNER,
  isAbort,
  isTransportDrop,
  lastUserMessageOf,
} from "./helpers";

/**
 * Rejoin a turn whose live stream dropped mid-flight (实时重连续看 C1 · slice 1b).
 *
 * Post-decoupling (slice 1a) a dropped connection no longer kills a turn — it
 * runs detached + persists — so a transport drop must RECONNECT, not resend (a
 * resend / regenerate would double-run a turn that is still alive). Resets the
 * partial assistant bubble (the replay re-sends the full transcript-so-far, so
 * keeping the partial would double it), then attaches: replay + live tail. On
 * `"none"` the run already finished — reload the persisted transcript (its reply
 * is saved). If reconnect itself drops, surface a banner whose retry reconnects
 * again (never resends).
 *
 * Returns `true` when handled (reattached / reloaded a saved reply / banner shown);
 * `false` only when there is no turn to rejoin and nothing was persisted, so the
 * caller can fall back to its resend / regenerate banner.
 */
export async function rejoinLiveTurn(conversationId: string): Promise<boolean> {
  const lastUser = lastUserMessageOf(conversationId);
  if (!lastUser) return false;

  const store = useConversationStore.getState();
  store.clearError(conversationId);
  // Drop any partial assistant bubble so the replay rebuilds it cleanly, then open
  // a fresh placeholder for instant feedback (message_start reuses it).
  store.truncateAfter(lastUser.id, conversationId);
  store.createAssistantMessage(conversationId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    const outcome = await attachConversation(conversationId, ac.signal);
    if (outcome === "attached") return true;
    // No live run — the detached turn already finished + persisted. Reload it so
    // the placeholder is replaced by the saved reply.
    await loadLatestWindow(conversationId);
    useConversationStore.getState().setGenerating(false, conversationId);
    const last = getRuntime(conversationId).messages.at(-1);
    // A persisted assistant reply means the detached turn delivered — handled.
    // Still ending on the user message means it produced nothing → let the caller
    // offer a resend.
    return last?.role === "assistant";
  } catch (err) {
    if (isAbort(err)) return true; // user stopped — handled
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    clearInteractionPrompts(conversationId);
    // A reconnect drop → manual「重连」(never resend); an auth failure stays silent
    // (the api layer already redirected to login).
    const msg = isTransportDrop(err)
      ? RECONNECT_BANNER
      : describeStreamError(err);
    if (msg) {
      s.setError(
        msg,
        () => void rejoinLiveTurn(conversationId),
        conversationId,
        streamErrorAction(err),
      );
    }
    return true;
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}

/**
 * On opening a conversation whose latest turn has no persisted reply yet, rejoin a
 * run that may still be live (实时重连续看 C1 · slice 1b — reopen the app / revisit
 * and 续看 it finish).
 *
 * Unlike {@link rejoinLiveTurn} this has no partial bubble to reset (the reopened
 * transcript ends at the user message); it attaches bare, and the replay's
 * `message_start` opens the bubble — so a 204 (nothing live) is a clean no-op with
 * no flicker. A drop while attached offers a manual reconnect.
 */
export async function attachOnOpen(conversationId: string): Promise<void> {
  const store = useConversationStore.getState();
  if (getRuntime(conversationId).isGenerating) return; // already streaming locally

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    await attachConversation(conversationId, ac.signal);
  } catch (err) {
    if (isAbort(err)) return;
    const s = useConversationStore.getState();
    // Only surface a reconnect banner if a bubble actually opened (a run was live
    // and we lost it); a pre-event drop / 204 stays silent.
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
      s.setError(
        RECONNECT_BANNER,
        () => void rejoinLiveTurn(conversationId),
        conversationId,
        null,
      );
    }
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}
