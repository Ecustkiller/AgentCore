import { ApiError, api } from "@/services/api";
import { type PendingApproval, useApprovalStore } from "@/stores/approvals";
import type { ApprovalDecision } from "@/types/events";

/**
 * POST the user's decision to the resolve endpoint.
 *
 * The paused tool call in the live `send_message` SSE stream resumes with the
 * decision, and the backend then emits `approval_resolved`. A 404 means the
 * request is stale (timed out, already settled, or the turn ended) and is left
 * to the caller to treat as a no-op.
 */
export async function resolveApproval(
  conversationId: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  await api.post(
    `/v1/conversations/${conversationId}/approvals/${approvalId}`,
    {
      decision,
    },
  );
}

/**
 * Other pending cards that a "本轮内都允许" on `approval` should auto-approve:
 * same conversation, same tool, not the card itself, not already in flight.
 *
 * Implements the documented batch放行 (安全权限与治理 §三): when several same-tool
 * calls are paused in parallel, allowing one "for the rest of the turn" approves
 * the siblings too instead of prompting N times. The grant is scoped to one
 * conversation's turn, so another conversation's same-tool prompt is left alone.
 * The backend grants the tool on the `approve_always`, so the siblings only need
 * a plain `approve`.
 */
export function autoApproveSiblings(
  pending: PendingApproval[],
  approval: PendingApproval,
): PendingApproval[] {
  return pending.filter(
    (p) =>
      p.approvalId !== approval.approvalId &&
      p.conversationId === approval.conversationId &&
      p.toolName === approval.toolName &&
      !p.resolving,
  );
}

/**
 * Settle one approval card (and, for `approve_always`, its same-tool siblings).
 *
 * On success the card is removed optimistically — the matching `approval_resolved`
 * event would remove it anyway, and both are idempotent. A 404 is stale → also
 * removed. Any other failure re-enables the card so the user can retry.
 */
export async function decideApproval(
  approval: PendingApproval,
  decision: ApprovalDecision,
): Promise<void> {
  const siblings =
    decision === "approve_always"
      ? autoApproveSiblings(useApprovalStore.getState().pending, approval)
      : [];

  await Promise.all([
    settleOne(approval, decision),
    ...siblings.map((s) => settleOne(s, "approve")),
  ]);
}

async function settleOne(
  approval: PendingApproval,
  decision: ApprovalDecision,
): Promise<void> {
  const store = useApprovalStore.getState();
  store.setResolving(approval.approvalId, true);
  try {
    await resolveApproval(
      approval.conversationId,
      approval.approvalId,
      decision,
    );
    store.remove(approval.approvalId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      store.remove(approval.approvalId);
      return;
    }
    store.setResolving(approval.approvalId, false);
    throw err;
  }
}
