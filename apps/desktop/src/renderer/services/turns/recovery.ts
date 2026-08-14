import { describeStreamError, streamErrorAction } from "@/lib/errors";
import { loadLatestWindow } from "@/services/messages";
import { type ConversationRecovery, loadRecovery } from "@/services/resume";
import {
  attachConversation,
  clearLastEventId,
} from "@/services/streamConversation";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { beginTurnPreflight } from "@/stores/conversation/turnPhaseActions";
import { useExecutionStore } from "@/stores/execution";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import {
  RECONNECT_BANNER,
  UNKNOWN_CLOUD_BANNER,
  finalizeGeneratingForPausedConversation,
  finalizeHonestStopAbort,
  isAbort,
  isTransportDrop,
  lastUserMessageOf,
} from "./helpers";
import { hasLocalConversationStream } from "./streamOwnership";

/** Cold-load pause latch is ``status=running`` + ``finishReason=paused``. */
function isPausedFinish(message: {
  finishReason?: string;
  runs?: { finishReason?: string } | null;
}): boolean {
  return (
    message.finishReason === "paused" || message.runs?.finishReason === "paused"
  );
}

/**
 * Settle a live execution slot to cancelled so {@link finalizeFold} freezes
 * in-flight nodes. No-op when there is no plan (avoids inventing empty slots).
 */
function finalizeRunningExecutionSlots(
  messageId: string,
  serverMessageId?: string | null,
): void {
  const exec = useExecutionStore.getState();
  const settle = (id: string) => {
    const rt = exec.byId[id];
    if (!rt?.plan) return;
    if (
      rt.status === "running" ||
      rt.status === "planning" ||
      rt.status === "paused"
    ) {
      exec.setStatus("cancelled", id);
    }
  };
  settle(messageId);
  if (serverMessageId && serverMessageId !== messageId) {
    settle(serverMessageId);
  }
}

/**
 * Rejoin a turn whose live stream dropped mid-flight (实时重连续看 C1 · slice 1b).
 *
 * Post-decoupling (slice 1a) a dropped connection no longer kills a turn — it
 * runs detached + persists — so a transport drop must RECONNECT, not resend (a
 * resend / regenerate would double-run a turn that is still alive). Attaches as-is:
 * replay + live tail. On `"none"` the run already finished — reload the persisted
 * transcript (its reply is saved). If reconnect itself drops, surface a banner
 * explaining the drop (no one-click reconnect; auto rejoin / reopen remain available).
 *
 * **不在这里清屏。** 手上这半场要不要抹，由 attach 段首的 ``full_replay`` 说了算
 * （``streamConversation.foldAttachSegment``）：服务端认得我们的游标时只补游标之后的
 * 事实，抢先清掉上半场就再也补不回来了——那正是掉线重连后回合前半段永久消失的成因。
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

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  beginTurnPreflight(conversationId);
  try {
    const outcome = await attachConversation(conversationId, ac.signal);
    if (outcome === "attached") return true;
    // No live run — the detached turn already finished + persisted. Reload it so
    // the saved reply replaces whatever partial we still hold. Clear generating
    // first so the whole-window write gate does not reject the reload.
    useConversationStore.getState().setGenerating(false, conversationId);
    await loadLatestWindow(conversationId);
    const last = getRuntime(conversationId).messages.at(-1);
    // A persisted assistant reply means the detached turn delivered — handled.
    // Still ending on the user message means it produced nothing → let the caller
    // offer a resend.
    return last?.role === "assistant";
  } catch (err) {
    if (isAbort(err)) {
      finalizeHonestStopAbort(conversationId);
      return true;
    }
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    clearInteractionPrompts(conversationId);
    // A reconnect drop → explain (never resend); an auth failure stays silent
    // (the api layer already redirected to login). No one-click reconnect.
    const msg = isTransportDrop(err)
      ? RECONNECT_BANNER
      : describeStreamError(err);
    if (msg) {
      s.setError(msg, null, conversationId, streamErrorAction(err));
    }
    return true;
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}

/**
 * Mark a dead-lease ghost (``usage.status=running`` but recovery has no live run
 * and no pause) as interrupted so the bubble stops spinning. Empty body → layer 1
 * recoverability (send a new turn / composer hint + synthetic「已中断」face); no
 * message-level retry row.
 *
 * No-op when the tail is already paused (``finishReason`` / ``runs.finishReason``)
 * — a successful pause must not be rewritten as interrupted.
 *
 * Also drops any resume card painted from a stale ``usage.paused`` latch + journal
 * residual (ask_user fact still in journal after the user already continued).
 */
export function markGhostInterrupted(conversationId: string): void {
  const store = useConversationStore.getState();
  const last = getRuntime(conversationId).messages.at(-1);
  if (!last || last.role !== "assistant" || last.status !== "running") return;
  // Successful pause (cold-load latch) must not be rewritten as interrupted.
  if (isPausedFinish(last)) return;
  store.updateMessage(
    last.id,
    {
      isStreaming: false,
      status: "incomplete",
      finishReason: "interrupted",
      runs: last.runs
        ? { ...last.runs, finishReason: "interrupted" }
        : last.runs,
    },
    conversationId,
  );
  useConversationStore.getState().setGenerating(false, conversationId);
  clearLastEventId(conversationId);
  // Freeze the graph in place (cancelled → finalizeFold freezes in-flight nodes).
  // Do not clearExecution — the inline team graph must stay until journal replay.
  finalizeRunningExecutionSlots(last.id, last.serverMessageId);
  // Stale latch may have painted ResumePrompt via toMessage → surfaceResume; clear it.
  const resumeKey = last.serverMessageId ?? last.id;
  usePausedTurnStore.getState().remove(resumeKey);
  clearInteractionPrompts(conversationId);
}

/**
 * Orphan empty-assistant settle (1a69f9dc · 方案 A).
 *
 * When a new turn starts (or hydrate finishes), any prior empty assistant that
 * never completed (streaming / running / abandoned incomplete) must not stay as
 * a blank product face. Rewrite to ``interrupted`` so
 * {@link syntheticErrorForEmptyFailure} paints「已中断」; do not hard-block input.
 *
 * Leaves ``cancelled`` / ``error`` / ``unproductive`` alone (those already have
 * product faces). Skips assistants with body or a real error payload.
 * Skips ``paused`` entirely — even ``status===running`` (cold-load latch).
 */
export function settleOrphanEmptyAssistants(conversationId: string): void {
  const store = useConversationStore.getState();
  const msgs = getRuntime(conversationId).messages;
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    if ((m.content ?? "").trim()) continue;
    if (m.error?.message?.trim()) continue;
    if (m.runs?.error?.message?.trim()) continue;
    // Successful pause must not become interrupted, even while still ``running``.
    if (isPausedFinish(m)) continue;
    const fr = m.finishReason ?? m.runs?.finishReason;
    // Already has a synthesizable terminal finish — keep it.
    if (
      fr === "cancelled" ||
      fr === "error" ||
      fr === "unproductive" ||
      fr === "interrupted"
    ) {
      if (!m.isStreaming && m.status !== "running") continue;
    }
    const needsSettle =
      m.isStreaming ||
      m.status === "running" ||
      m.status === "incomplete" ||
      // Settled blank with no finish (abandoned placeholder before message_end).
      (!fr && m.status !== "complete" && m.status !== "failed");
    if (!needsSettle) continue;
    store.updateMessage(
      m.id,
      {
        isStreaming: false,
        status: "incomplete",
        finishReason: "interrupted",
        runs: m.runs ? { ...m.runs, finishReason: "interrupted" } : m.runs,
      },
      conversationId,
    );
    // Freeze any live graph; do not wipe the projection (graph stays on screen).
    finalizeRunningExecutionSlots(m.id, m.serverMessageId);
  }
}

/**
 * Cloud-path settle for a last assistant with ``status===running``.
 *
 * Open-time hydrate races ``loadRecovery`` against ``fetchMessageWindow``;
 * recovery often finishes first. A cold pause that lands in between leaves a
 * stale empty snapshot (``!cloudLive ∧ pausedCount===0``) while the message
 * window still shows ``running`` — marking ghost then would wipe the pause
 * latch. Re-fetch once when the snapshot looks empty (sidecarAttach
 * ``attached:false`` precedent), then decide on the fresh facts:
 *
 * - live ∧ paused=0 → rejoin
 * - paused≥1 → hold + clear generating/streaming (card + isGenerating is illegal)
 * - cloudKnown ∧ !live ∧ paused=0 → real dead-lease / TTL degrade → ghost
 *   unless the tail is already paused (cold-load latch) — then hold, never ghost
 * - !cloudKnown → unknown (request failed); never ghost — hold; keep a prior
 *   non-empty non-{@link UNKNOWN_CLOUD_BANNER} error, else set that banner
 *   (plain banner; never resend; not {@link RECONNECT_BANNER})
 */
export async function settleCloudRunningAssistant(
  conversationId: string,
  recovery: ConversationRecovery,
): Promise<"rejoin" | "ghost" | "hold"> {
  const store = useConversationStore.getState();
  // Do not clearError at entry — a prior concrete banner (e.g. stream drop)
  // must survive an unknown-cloud hold. Clear only on branches that change
  // turn state (rejoin / ghost / paused finalize).

  let snap = recovery;
  // Empty or unknown cloud facts: one refresh before deciding (same race as pause).
  if ((!snap.cloudKnown || !snap.cloudLive) && snap.pausedCount === 0) {
    snap = await loadRecovery(conversationId);
  }
  if (snap.cloudLive && snap.pausedCount === 0) {
    store.clearError(conversationId);
    void rejoinLiveTurn(conversationId);
    return "rejoin";
  }
  if (!snap.cloudKnown) {
    // Failure ≠ confirmed idle — leave the running assistant alone. Keep a
    // prior non-empty, non-UNKNOWN banner; otherwise explain honestly (not
    // "连接中断"). No one-click re-settle from the banner.
    const prior = (getRuntime(conversationId).error ?? "").trim();
    if (!prior || prior === UNKNOWN_CLOUD_BANNER) {
      store.setError(UNKNOWN_CLOUD_BANNER, null, conversationId, null);
    }
    return "hold";
  }
  if (!snap.cloudLive && snap.pausedCount === 0) {
    const last = getRuntime(conversationId).messages.at(-1);
    if (last?.role === "assistant" && isPausedFinish(last)) {
      store.clearError(conversationId);
      finalizeGeneratingForPausedConversation(conversationId, { force: true });
      return "hold";
    }
    store.clearError(conversationId);
    markGhostInterrupted(conversationId);
    return "ghost";
  }
  // paused≥1: force clear even if pausedTurns lag the recovery snap.
  store.clearError(conversationId);
  finalizeGeneratingForPausedConversation(conversationId, { force: true });
  return "hold";
}

/**
 * On opening a conversation, rejoin a live run or mark a dead ghost interrupted
 * (P4 unified hydrate · 实时重连续看 C1 · slice 1b). Empty interrupted → layer 1
 * (send new turn); not a resume affordance.
 *
 * - Last message is user + liveRunning → bare attach (``message_start`` opens bubble).
 * - Last message is running assistant + liveRunning → rejoin; the attach 段首 decides
 *   whether that partial is reset or continued (never double-folded).
 * - Last message is running assistant but no live / pause → ghost → interrupted.
 */
export async function attachOnOpen(conversationId: string): Promise<void> {
  const store = useConversationStore.getState();
  if (hasLocalConversationStream(conversationId)) return;

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  beginTurnPreflight(conversationId);
  try {
    await attachConversation(conversationId, ac.signal);
  } catch (err) {
    if (isAbort(err)) {
      finalizeHonestStopAbort(conversationId);
      return;
    }
    const s = useConversationStore.getState();
    // Only surface a reconnect banner if a bubble actually opened (a run was live
    // and we lost it); a pre-event drop / 204 stays silent.
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
      s.setError(RECONNECT_BANNER, null, conversationId, null);
    }
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}
