/**
 * `message_end.finish_reason` → terminal turn / execution status.
 * Mirrors the Python oracle (`agentcore.conformance.projection._FINISH_TO_STATUS`).
 */

/** Status values produced by {@link turnStatusFromFinish} (subset of TurnStatus / ExecutionStatus). */
export type FinishMappedStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

export const FINISH_TO_STATUS: Readonly<Record<string, FinishMappedStatus>> = {
  end_turn: "completed",
  max_rounds: "completed",
  degraded: "completed",
  unproductive: "completed",
  error: "failed",
  cancelled: "cancelled",
  // Crash / lease-sweeper salvage (流式回复持久化 P4): incomplete → cancelled-class.
  interrupted: "cancelled",
  // 挂起即收口 (②): turn finalized AT a durable checkpoint → stay paused.
  paused: "paused",
};

/** Map `message_end.finish_reason` to a terminal status; unknown reasons → completed. */
export function turnStatusFromFinish(
  finishReason: string,
): FinishMappedStatus {
  return FINISH_TO_STATUS[finishReason] ?? "completed";
}
