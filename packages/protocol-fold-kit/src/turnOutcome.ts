/**
 * Turn-level result quality: `ok | partial | paused | error`.
 * Mirrors the Python oracle (`agentcore.runtime.turn.outcome`).
 *
 * `finish_reason` answers how the loop ended; this answers what the turn produced.
 * Partial is OR of batch/node bits already on the wire — no new heuristics.
 * `paused` is produced only when the wire sets it explicitly (CEO rate-limit
 * continue). Gate pauses keep outcome null.
 */

export type TurnOutcome = "ok" | "partial" | "paused" | "error";

export const PRODUCED_OUTCOMES = ["ok", "partial", "paused", "error"] as const;

export type ProducedTurnOutcome = (typeof PRODUCED_OUTCOMES)[number];

/** Minimal event shape — fold-kit does not depend on contract-types. */
export type OutcomeWireEvent = {
  type: string;
  payload?: unknown;
};

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

export function coerceProducedOutcome(
  value: unknown,
): ProducedTurnOutcome | null {
  if (
    value === "ok" ||
    value === "partial" ||
    value === "paused" ||
    value === "error"
  ) {
    return value;
  }
  return null;
}

export function eventsHavePartialProduct(
  events: readonly OutcomeWireEvent[] | null | undefined,
): boolean {
  if (!events) return false;
  for (const ev of events) {
    const payload = payloadRecord(ev.payload);
    if (ev.type === "delivery_status" && payload.state === "partial") {
      return true;
    }
    if (ev.type === "run_failed" && payload.product_landed === true) {
      return true;
    }
    if (ev.type === "tool_use_end" && payload.partial_failure === true) {
      return true;
    }
  }
  return false;
}

export function resolveTurnOutcome(args: {
  events?: readonly OutcomeWireEvent[] | null;
  finishReason?: string | null;
  hasError?: boolean;
  explicit?: unknown;
  running?: boolean;
}): TurnOutcome | null {
  if (args.running) return null;
  const chosen = coerceProducedOutcome(args.explicit);
  if (chosen != null) return chosen;
  if (eventsHavePartialProduct(args.events)) return "partial";
  if (args.finishReason === "paused") return null;
  if (args.hasError || args.finishReason === "error") return "error";
  return "ok";
}
