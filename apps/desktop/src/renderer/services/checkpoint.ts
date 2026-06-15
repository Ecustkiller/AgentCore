import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import { useConversationStore } from "@/stores/conversation";
import type { CheckpointDecision } from "@/types/events";

/** The decisions the user can actively make on a checkpoint card. `timeout` is
 * engine-only (a no-answer deadline) and never POSTed by the client. */
export type CheckpointUserDecision = Exclude<CheckpointDecision, "timeout">;

/**
 * POST the user's checkpoint decision to the resolve endpoint.
 *
 * The paused `ask_user` call in the live `send_message` SSE stream resumes with
 * the decision, and the backend then emits `checkpoint_resolved` (which flips the
 * card to its settled state). A 404 means the checkpoint is stale (timed out,
 * already settled, or the turn ended) — we settle the card locally so it stops
 * soliciting input. Any other failure propagates so the card can re-enable and
 * the user can retry.
 *
 * @param note the user's steer (for `adjust`) or an optional closing remark (for
 *   `stop`); ignored by the backend for `continue`.
 */
export async function decideCheckpoint(
  conversationId: string,
  checkpointId: string,
  decision: CheckpointUserDecision,
  note: string,
): Promise<void> {
  try {
    await resolveInteraction(conversationId, checkpointId, {
      kind: "ask_user",
      decision,
      note,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      useConversationStore
        .getState()
        .settleCheckpoint(checkpointId, decision, note, conversationId);
      return;
    }
    throw err;
  }
}
