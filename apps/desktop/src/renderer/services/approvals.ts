import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import { type PendingApproval, useApprovalStore } from "@/stores/approvals";
import type { ApprovalDecision } from "@/types/events";

/**
 * Settle the user's decision over the unified interaction bridge (kind `approval`).
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
  await resolveInteraction(conversationId, approvalId, {
    kind: "approval",
    decision,
  });
}

/**
 * The file-mutation tool class the「本轮内允许所有文件改动」grant covers, mirroring
 * the backend `file_mutation_tool_names()` (GRANTABLE ∩ FILESYSTEM). `code_execute`
 * is deliberately excluded — it keeps its own per-tool gate.
 *
 * This client copy drives only the optimistic fast-path: which cards show the class
 * button and which to clear instantly on click. The backend gate is authoritative —
 * it sweeps every pending file-op call when `approve_always_files` lands — so drift
 * here can at worst leave a sibling card up for one SSE round-trip, never mis-grant.
 */
export const FILE_OP_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "str_replace",
  "file_delete",
  "file_move",
]);

/** Whether `name` is in the file-mutation class (so its card offers, and is swept
 * by, the「本轮内允许所有文件改动」grant). */
export function isFileOpTool(name: string): boolean {
  return FILE_OP_TOOLS.has(name);
}

/**
 * Other pending cards a turn-scoped grant on `approval` should auto-approve:
 * same conversation, in the grant's scope, not the card itself, not already in
 * flight. `approve_always` scopes to the same tool; `approve_always_files` scopes
 * to the whole file-mutation class; one-shot `approve` / `deny` sweep nothing.
 *
 * Implements the documented batch放行 (安全权限与治理 §三): when several in-scope
 * calls are paused in parallel, one "for the rest of the turn" approves the siblings
 * too instead of prompting N times. The grant is scoped to one conversation's turn,
 * so another conversation's prompt is left alone.
 *
 * The authoritative sweep is on the backend gate: `ApprovalGate` resolves every
 * in-scope pending request when the grant lands (`list_pending` is the source of
 * truth), which closes the race where a sibling's `approval_required` hasn't reached
 * this store yet at click time. This client pass is the optimistic fast-path for
 * instant card removal, idempotent with it (a double-resolve no-ops).
 */
export function autoApproveSiblings(
  pending: PendingApproval[],
  approval: PendingApproval,
  decision: ApprovalDecision,
): PendingApproval[] {
  const inScope =
    decision === "approve_always"
      ? (p: PendingApproval) => p.toolName === approval.toolName
      : decision === "approve_always_files"
        ? (p: PendingApproval) => isFileOpTool(p.toolName)
        : () => false;
  return pending.filter(
    (p) =>
      p.approvalId !== approval.approvalId &&
      p.conversationId === approval.conversationId &&
      !p.resolving &&
      inScope(p),
  );
}

/**
 * Settle one approval card (and, for a turn-scoped grant, its in-scope siblings).
 *
 * On success the card is removed optimistically — the matching `approval_resolved`
 * event would remove it anyway, and both are idempotent. A 404 is stale → also
 * removed. Any other failure re-enables the card so the user can retry.
 */
export async function decideApproval(
  approval: PendingApproval,
  decision: ApprovalDecision,
): Promise<void> {
  const siblings = autoApproveSiblings(
    useApprovalStore.getState().pending,
    approval,
    decision,
  );

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
