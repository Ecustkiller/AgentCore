/**
 * Pure cost-derivation helper for the turn cost row (§7.3A). Framework-free on
 * purpose: the money math lives here so it is unit-testable without a DOM, and
 * the components only render the result. (Per-Agent ¥ now shows directly on each
 * graph node from `run.cost`, §7.3B — no payroll split needed.)
 *
 * Money is integer nano-USD throughout (1 USD = 1e9). This never re-prices; it
 * only sums already-priced run totals (§7.2：合计以各 run 已定价之和为准).
 */

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
