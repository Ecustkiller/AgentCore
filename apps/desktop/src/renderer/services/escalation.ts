import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";

/**
 * The two calls a user can make on a blocking escalation card (阻塞式求决策 §4.5): answer the
 * worker's question, or 按假设继续 (degrade to the worker's stated assumption). UNLIKE plan_review
 * there is no 停止 — ending the whole turn is the conversation-level / CEO `ask_user` job, not a
 * single worker's escalation.
 */
export type EscalationUserDecision =
  | { kind: "answer"; answer: string }
  | { kind: "use_assumption" };

/**
 * POST the user's call on a worker's blocking escalate to the unified resolve endpoint.
 *
 * The worker SUSPENDED itself mid-wave (the CEO is parked at its `delegate`, so it asks the user
 * directly) and is awaiting this over the in-process interaction bridge. The suspending tool's
 * awaiter — never this route — emits `escalation_resolved` (单一发射者), which folds the run's
 * pending escalation to `resolved`/`timeout`; so the card settles from the live stream, not here.
 *
 * `answer` is fed back into the worker's loop (overriding its暂定假设); `use_assumption`
 * (按假设继续) degrades to the worker's stated assumption — the same disposition as a timeout.
 *
 * A 404 means the escalation is already closed (timed out / answered / the turn ended): swallow it
 * — the matching `escalation_resolved` already settled, or will settle, the card. Any other failure
 * propagates so the card can re-enable for a retry.
 */
export async function decideEscalation(
  conversationId: string,
  escalationId: string,
  decision: EscalationUserDecision,
): Promise<void> {
  try {
    await resolveInteraction(conversationId, escalationId, {
      kind: "escalation",
      answer: decision.kind === "answer" ? decision.answer : "",
      use_assumption: decision.kind === "use_assumption",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}
