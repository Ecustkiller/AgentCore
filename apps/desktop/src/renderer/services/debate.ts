import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";

/**
 * The user's call on an interactive debate round boundary (逐轮辩论语义化, opt-in §逐轮交互):
 * continue debating (optionally 加角度 = inject the next round's focus) or conclude now (emit the
 * brief even if the judge had not converged). Unlike an escalation there is no separate「按假设」—
 * not answering simply lets the round time out into the judge's auto-convergence (the engine's
 * `timeout` fallback), so the only two user-driven calls are these.
 */
export type DebateRoundUserDecision =
  | { kind: "continue"; focus: string }
  | { kind: "conclude" };

/**
 * POST the user's round-boundary call to the unified resolve endpoint (kind=`debate_round`).
 *
 * The Moderator SUSPENDED at the boundary (in-process bridge, like a blocking escalate — the
 * debate's state lives in the awaiting coroutine, never durably persisted) and is awaiting this.
 * The suspending tool's awaiter — never this route — emits `debate_round_decision_resolved`, which
 * settles the card from the live stream; so the card flips to 已继续/已结论 from the SSE fold, not
 * here. `continue` (+ optional `focus` = 加角度) debates another round; `conclude` stops now.
 *
 * A 404 means the decision is already closed (timed out into auto-convergence / the turn ended):
 * swallow it — the matching `debate_round_decision_resolved` already settled, or will settle, the
 * card. Any other failure propagates so the card can re-enable for a retry.
 */
export async function decideDebateRound(
  conversationId: string,
  decisionId: string,
  decision: DebateRoundUserDecision,
): Promise<void> {
  try {
    await resolveInteraction(conversationId, decisionId, {
      kind: "debate_round",
      decision: decision.kind,
      focus: decision.kind === "continue" ? decision.focus : "",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}
