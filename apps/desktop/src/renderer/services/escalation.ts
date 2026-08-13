import {
  type SubmitInteractionResult,
  isInteractionOrphanedError,
  submitInteraction,
} from "@/services/interactionSubmit";
import { useInteractionStore } from "@/stores/interactions";

export type EscalationUserDecision =
  | { kind: "answer"; answer: string }
  | { kind: "use_assumption" }
  | { kind: "transfer_ownership" }
  | { kind: "keep_ownership" };

/**
 * POST the user's call on a worker's blocking escalate via the unified submit path.
 * 410 → orphaned 灰态; 「已经结了」的回执 → `already_settled`（关掉操作面，不认领是谁结的
 * ——这条也可能是主管接管仲裁或超时兜底）; other failures reopen for retry.
 */
export async function decideEscalation(
  conversationId: string,
  escalationId: string,
  decision: EscalationUserDecision,
): Promise<SubmitInteractionResult> {
  try {
    const transfer = decision.kind === "transfer_ownership";
    const keep = decision.kind === "keep_ownership";
    return await submitInteraction({
      id: escalationId,
      kind: "escalation",
      conversationId,
      hotBody: {
        kind: "escalation",
        answer:
          decision.kind === "answer"
            ? decision.answer
            : transfer
              ? "移交写权给升级方"
              : keep
                ? "保持原主写权"
                : "",
        use_assumption: decision.kind === "use_assumption",
        transfer_ownership: transfer,
      },
    });
  } catch (err) {
    if (isInteractionOrphanedError(err)) {
      useInteractionStore.getState().markOrphaned(escalationId);
      return "orphaned";
    }
    throw err;
  }
}
