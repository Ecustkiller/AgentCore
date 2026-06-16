import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import { useConversationStore } from "@/stores/conversation";

/** The decisions the user can actively make on a plan_review card (结构化挂起):
 * `continue` runs the gated downstream steps as-is, `adjust` injects the note as a
 * steer onto the downstream steps and then runs them, `stop` ends the run here.
 * `timeout` is engine-only, so it is never POSTed by the client. */
export type PlanReviewUserDecision = "continue" | "adjust" | "stop";

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
 * @param note the steer injected onto downstream steps for `adjust`, a closing
 * remark for `stop`; ignored by the backend for `continue`.
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
