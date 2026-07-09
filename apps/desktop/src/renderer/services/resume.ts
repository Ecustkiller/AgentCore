import { api } from "@/services/api";
import { resolveSidecarRoot } from "@/services/sidecarRouting";
import { useApprovalStore } from "@/stores/approvals";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import { getRuntime } from "@/stores/conversation";
import { usePausedTurnStore, type ResumeOrigin } from "@/stores/pausedTurns";
import type { components } from "@/types/api.generated";

type PausedTurnSummary = components["schemas"]["PausedTurnSummary"];
type PendingApprovalSummary = components["schemas"]["PendingApprovalSummary"];
type TurnRecoveryResponse = components["schemas"]["TurnRecoveryResponse"];

/** A conversation's recovery snapshot on reopen — see {@link loadRecovery}. */
export interface ConversationRecovery {
  /** A detached cloud run is still live to 续看 (实时重连续看 C1 · slice 1b), so the
   * caller may attach (GET .../stream) to replay + tail it. Always false for a local
   * (sidecar) conversation — the sidecar keeps no reattachable run across a reopen. */
  liveRunning: boolean;
  /** How many turns are durably paused awaiting resume (结构化挂起 2b). When > 0 the
   * resume card is the single actionable surface, so the caller must NOT also attach. */
  pausedCount: number;
}

function hydrateRecoveredApprovals(
  conversationId: string,
  summaries: PendingApprovalSummary[],
): void {
  const store = useApprovalStore.getState();
  store.clear(conversationId);
  for (const a of summaries) {
    store.add({
      approval_id: a.approval_id,
      conversation_id: a.conversation_id ?? conversationId,
      tool_call_id: a.tool_call_id,
      tool_name: a.tool_name,
      arguments: (a.arguments ?? {}) as Record<string, unknown>,
    });
  }
}

/**
 * Load a conversation's recovery state into the store on reopen (best-effort).
 *
 * Replaces the former two independent reopen probes (GET /paused + the GET /stream
 * attach) with ONE snapshot, so reopen picks a single actionable surface without racing
 * them: a turn parked at a checkpoint is BOTH live (its run parked, holding the lock)
 * and durably paused (its frame persisted before the suspend await), and surfacing both
 * stacked a duplicate 拍板 card. Routed like a send (双模式工作区 §一.1): a conversation
 * bound to a present local root reads its local frame files via the sidecar bridge (no
 * Python spawn — and the sidecar keeps no reattachable run, so liveRunning is false);
 * else the cloud /recovery endpoint returns {live_running, paused}. Either way the paused
 * frames are pushed into the store (rendering the resume cards) and the snapshot is
 * returned so the caller decides whether to also 续看 a live, non-paused turn. A lookup
 * failure is swallowed (returns the empty snapshot) — it must never block reopening a
 * conversation (the turn stays recoverable on a later reopen).
 */
export async function loadRecovery(
  conversationId: string,
): Promise<ConversationRecovery> {
  try {
    // listPaused 读本机帧文件、按会话过滤（不拉起 Python、与子路径无关），故只需容器根 id。
    const sidecarTarget = await resolveSidecarRoot(conversationId);
    if (sidecarTarget) {
      const paused = (await window.sidecarApi.listPaused({
        rootId: sidecarTarget.rootId,
        conversationId,
      })) as unknown as PausedTurnSummary[];
      usePausedTurnStore
        .getState()
        .setForConversation(conversationId, paused, "sidecar");
      // Local sidecar runs keep no reattachable approval registry across reopen.
      clearInteractionPrompts(conversationId);
      return { liveRunning: false, pausedCount: paused.length };
    }
    const res = await api.get<TurnRecoveryResponse>(
      `/v1/conversations/${conversationId}/recovery`,
    );
    const paused = res.paused ?? [];
    usePausedTurnStore
      .getState()
      .setForConversation(conversationId, paused, "server");
    hydrateRecoveredApprovals(conversationId, res.pending_approvals ?? []);
    return {
      liveRunning: Boolean(res.live_running),
      pausedCount: paused.length,
    };
  } catch {
    /* best-effort: never block reopening on a recovery lookup */
    return { liveRunning: false, pausedCount: 0 };
  }
}

/**
 * 挂起即收口 (②): surface the durable resume card for a turn that just ENDED at a
 * checkpoint on the LIVE stream (message_end finish_reason=paused).
 *
 * With ② a durable checkpoint finalizes the turn in place — the in-process resolve
 * Future is never parked — so the now-dormant inline checkpoint card must hand off to
 * the (single) resume card (POST .../resume), the same surface a reopen shows. Unlike
 * {@link loadRecovery} (the reopen path, which re-reads the persisted frame from the
 * backend), this builds the resume entry from the pending checkpoint the *_required
 * event already folded onto the turn's bubble — so it needs NO /recovery round-trip and
 * reproduces offline in #/preview (which replays the same vector through this very path).
 * Idempotent by messageId; a no-op if the finalized turn carries no pending checkpoint.
 */
/** True when `messageId` is a client bubble id with no stamped server message_id. */
export function isClientOnlyResumeKey(
  conversationId: string,
  messageId: string,
): boolean {
  const assistant = getRuntime(conversationId).messages.find(
    (m) => m.role === "assistant" && m.id === messageId,
  );
  return assistant !== undefined && !assistant.serverMessageId;
}

export function surfaceResumeFromLiveTurn(
  conversationId: string,
  origin: ResumeOrigin,
): void {
  const messages = getRuntime(conversationId).messages;
  const turn = [...messages].reverse().find((m) => m.role === "assistant");
  if (!turn) return;
  const serverMessageId = turn.serverMessageId;
  if (!serverMessageId) {
    console.warn(
      `[Resume] Cannot surface resume card: serverMessageId not stamped turnId=${turn.id}`,
    );
    return;
  }
  const base = {
    // The resume KEY is the SERVER message_id (stamped from message_start); the bubble's
    // own `id` is a client UUID and would 404 the durable frame lookup.
    messageId: serverMessageId,
    conversationId,
    // The user request that opened this turn — context shown on the resume card.
    userMessage:
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "",
    userMessageId:
      [...messages].reverse().find((m) => m.role === "user")?.id ?? "",
    origin,
  };
  const cp = turn.checkpoints?.find((c) => c.status === "pending");
  if (cp) {
    usePausedTurnStore.getState().addLiveResume({
      ...base,
      checkpointId: cp.id,
      kind: "ask_user",
      steps: [],
      pending: [],
      question: cp.question,
      context: cp.context,
      assumptions: cp.assumptions,
      questions: cp.questions,
      styleOptions: cp.styleOptions,
      intent: cp.intent,
    });
    return;
  }
  const pr = turn.planReviews?.find((c) => c.status === "pending");
  if (pr) {
    usePausedTurnStore.getState().addLiveResume({
      ...base,
      checkpointId: pr.id,
      kind: "plan_review",
      steps: pr.steps,
      pending: pr.pending,
      question: "",
      context: "",
      assumptions: [],
      questions: [],
      styleOptions: [],
      intent: "decision",
    });
  }
}
