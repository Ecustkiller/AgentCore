// Turn-verdict envelope — protocol-external judgment (`lib/turnOutcome`) that
// the fold golden does not cover. Same fixtures / harness / golden pipeline as
// ProjectedTurn; this is an optional sidecar on the fixture, not a second gate.
//
// Judge encoding is the two desktop fields (`hasTeamStrip` + `supportPackHost`).
// Mobile still drives its own UI with a local `surface`; the envelope must
// translate that into the two fields. `surface` is not part of this sidecar.

import type { ProjectedTurn } from "./projectedTurn";
import { GATE_INTERACTION_KINDS } from "./projectedTurn";

/** Where「复制排查包」hangs. The failure banner is not a host. */
export type TurnSupportPackHost = "none" | "more";

export type ProjectedTurnVerdict = {
  kind?: "ok" | "partial" | "paused" | "error";
  hideEmptyBubble?: boolean;
  notice?: string | null;
  /** Team strip exists for this turn (scoreboard still up). */
  hasTeamStrip?: boolean | null;
  /** Where「复制排查包」hangs. Orthogonal to {@link hasTeamStrip}. */
  supportPackHost?: TurnSupportPackHost | null;
};

/**
 * Hand-filled golden can invent combos the arbitrator never emits.
 * `more` (bubble-footer「复制排查包」) needs a bubble that is still on screen.
 */
export function turnVerdictHostContradiction(
  verdict: Pick<
    ProjectedTurnVerdict,
    "hideEmptyBubble" | "supportPackHost"
  >,
): string | null {
  if (verdict.hideEmptyBubble === true && verdict.supportPackHost === "more") {
    return 'hideEmptyBubble 与 supportPackHost="more" 互斥（空壳没有排查包）';
  }
  return null;
}

export function projectedHasTeamGraph(p: ProjectedTurn): boolean {
  return (p.runs?.length ?? 0) > 0 || (p.process ?? []).some((s) => s.kind === "team");
}

export function projectedHasDedicatedPauseUi(p: ProjectedTurn): boolean {
  return p.interactions.some(
    (i) =>
      (i.status === "pending" || i.status === "resolved") &&
      (GATE_INTERACTION_KINDS as readonly string[]).includes(i.kind),
  );
}
