import {
  isInteractionOrphanedError,
  submitInteraction,
} from "@/services/interactionSubmit";
import { useInteractionStore } from "@/stores/interactions";

/**
 * The user's call on an interactive debate round boundary.
 * 「让裁判决定」= conclude (always available on the SteeringBar).
 */
export type DebateRoundUserDecision =
  | { kind: "continue"; focus: string; ask: string; askTarget: string }
  | { kind: "conclude"; ask: string; askTarget: string };

export async function decideDebateRound(
  conversationId: string,
  decisionId: string,
  decision: DebateRoundUserDecision,
): Promise<"ok" | "orphaned" | "busy"> {
  try {
    return await submitInteraction({
      id: decisionId,
      kind: "debate_round",
      conversationId,
      hotBody: {
        kind: "debate_round",
        decision: decision.kind,
        focus: decision.kind === "continue" ? decision.focus : "",
        ask: decision.ask,
        ask_target: decision.askTarget,
      },
    });
  } catch (err) {
    if (isInteractionOrphanedError(err)) {
      useInteractionStore.getState().markOrphaned(decisionId);
      return "orphaned";
    }
    throw err;
  }
}
