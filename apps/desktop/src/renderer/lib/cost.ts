/**
 * Pure cost-derivation helpers for the team payroll (§7.3B) and the turn cost
 * row (§7.3A). Framework-free on purpose: the non-trivial money math — the
 * product differentiator「CEO ¥0.03 / 调研员 ¥0.05」— lives here so it is
 * unit-testable without a DOM, and the components only render the result.
 *
 * Money is integer nano-USD throughout (1 USD = 1e9). These never re-price; they
 * only split / sum already-priced run totals (§7.2：合计以各 run 已定价之和为准).
 */

/** A turn's payroll split: the CEO row + the aggregate figures the bars need. */
export interface PayrollSplit {
  /** CEO/captain spend = turn total − Σworkers (floored at 0); 0 until the turn
   * total is known (`message_end`). The captain runs the turn's own ReAct loop,
   * not a scheduled run, so its spend is the remainder, not a row total. */
  captainCost: number;
  /** Σ of the worker run totals (0 for runs that have not finished pricing). */
  workersTotal: number;
  /** The authoritative turn total when known, else the workers' running sum. */
  total: number;
  /** The biggest single row (captain or any worker), floored at 1 so an all-zero
   * turn yields a flat bar instead of a divide-by-zero. Bars normalise over this. */
  maxCost: number;
}

/**
 * Split a turn's spend into the CEO row + the figures the payroll bars need.
 *
 * @param turnTotal authoritative turn aggregate from `message_end` (captain +
 *   members), or null until the turn ends.
 * @param workerCosts each worker run's total (0 for unfinished/unpriced runs).
 */
export function splitPayroll(
  turnTotal: number | null,
  workerCosts: number[],
): PayrollSplit {
  const workersTotal = workerCosts.reduce((n, c) => n + c, 0);
  const captainCost =
    turnTotal != null ? Math.max(turnTotal - workersTotal, 0) : 0;
  const total = turnTotal ?? workersTotal;
  const maxCost = Math.max(captainCost, ...workerCosts, 1);
  return { captainCost, workersTotal, total, maxCost };
}

/**
 * The turn cost to display (§7.3A): prefer the authoritative `turnTotal` from
 * `message_end`; when absent (a stopped/crashed turn never gets one) fall back to
 * the sum of the runs that did finish — a lower bound, but it still shows what the
 * team已花. Returns null when there is nothing real to show, so callers render
 * 「—」/ nothing rather than「¥0.00」(§7.5).
 *
 * Note `turnTotal` of 0 is returned verbatim (it is a known total, not "unknown");
 * the caller still gates display on `> 0`.
 */
export function resolveTurnCost(
  turnTotal: number | null,
  runCosts: number[],
): number | null {
  const runTotal = runCosts.reduce((n, c) => n + c, 0);
  return turnTotal ?? (runTotal > 0 ? runTotal : null);
}
