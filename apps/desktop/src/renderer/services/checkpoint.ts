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
 *   `stop`); the backend ignores it for `continue`.
 * @param selected the option(s) the user picked from the CEO's menu; rides
 *   `continue` and `adjust` (the backend drops any pick not actually offered).
 */
export async function decideCheckpoint(
  conversationId: string,
  checkpointId: string,
  decision: CheckpointUserDecision,
  note: string,
  selected: string[],
): Promise<void> {
  try {
    await resolveInteraction(conversationId, checkpointId, {
      kind: "ask_user",
      decision,
      note,
      selected,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      useConversationStore
        .getState()
        .settleCheckpoint(
          checkpointId,
          decision,
          note,
          selected,
          conversationId,
        );
      return;
    }
    throw err;
  }
}
