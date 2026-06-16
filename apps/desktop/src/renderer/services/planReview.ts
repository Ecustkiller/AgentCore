import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import { useConversationStore } from "@/stores/conversation";

/** The decisions the user can actively make on a plan_review card (结构化挂起 2a):
 * `continue` runs the gated downstream steps, `stop` ends the run here. `adjust`
 * is deferred (the backend treats it as continue) and `timeout` is engine-only, so
 * neither is ever POSTed by the client. */
export type PlanReviewUserDecision = "continue" | "stop";

/**
 * POST the user's plan_review decision to the unified resolve endpoint.
 *
 * The WaveScheduler paused after a `checkpoint_after` step (结构化挂起 2a) and is
 * awaiting this answer over the in-process interaction bridge; the backend then
 * emits `plan_review_resolved` (which flips the card to its settled state). A 404
 * means the checkpoint is stale (timed out, already settled, or the turn ended) —
 * we settle the card locally so it stops soliciting input. Any other failure
 * propagates so the card can re-enable and the user can retry.
 *
 * @param note an optional remark; ignored by the backend for `continue`.
 */
export async function decidePlanReview(
  conversationId: string,
  checkpointId: string,
  decision: PlanReviewUserDecision,
  note: string,
): Promise<void> {
  try {
    await resolveInteraction(conversationId, checkpointId, {
      kind: "plan_review",
      decision,
      note,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      useConversationStore
        .getState()
        .settlePlanReview(checkpointId, decision, note, conversationId);
      return;
    }
    throw err;
  }
}
