/**
 * Pure cost-derivation helper for the turn cost row (§7.3A). Framework-free on
 * purpose: the money math lives here so it is unit-testable without a DOM, and
 * the components only render the result. (Per-Agent money now shows directly on
 * each graph node from `run.cost`, §7.3B — no payroll split needed.)
 *
 * Money is integer nano throughout (1 unit = 1e9), in whatever currency the
 * backend stamped on it — platform ledger CNY, BYOK community estimate USD.
 * This never re-prices and **never converts**; it only sums already-priced run
 * totals (§7.2：合计以各 run 已定价之和为准) within a single currency.
 * BYOK: billed `total` stays 0; `estimated_total` may carry a community estimate.
 */

export type CostLeaf = {
  total: number;
  currency?: string | null;
  estimated_total?: number | null;
  estimated_currency?: string | null;
  pricing_source?: string | null;
};

export type DisplayMoney = {
  nano: number;
  /** True when showing BYOK estimate (≈), not platform ledger money. */
  estimated: boolean;
  /** ISO code of {@link nano}. Renderers pick the symbol from this, never guess. */
  currency: string;
};

/** 无 FX：跨币种金额不可相加，所以合计只在同一币种内累加。 */
const DEFAULT_CURRENCY = "CNY";

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

/**
 * True when the graph did real work that the platform simply cannot price —
 * some run consumed tokens under `pricing_source=unpriced` (BYOK, 两层价卡全落空).
 * Callers use this to show an explicit「自带密钥·未计价」badge instead of silently
 * omitting the cost segment (which reads as "free"). Zero-usage runs don't count.
 */
export function hasUnpricedUsage(
  runs: Array<
    | {
        cost?: CostLeaf | null;
        usage?: { input: number; output: number } | null;
      }
    | null
    | undefined
  >,
): boolean {
  return runs.some((r) => {
    if (!r?.cost || r.cost.pricing_source !== "unpriced") return false;
    const u = r.usage;
    return u != null && u.input + u.output > 0;
  });
}

/**
 * Turn display money with BYOK estimate awareness: billed total wins; else
 * `estimated_total`; else sum finished runs the same way. Null = nothing to show.
 *
 * The chosen amount carries its own currency out — billed reads `currency`, the
 * BYOK estimate reads `estimated_currency` — so the caller never has to infer a
 * symbol. In the run-sum fallback each bucket keeps the first contributing run's
 * currency; runs in a turn share a credential source, so they share a price card
 * table and cannot mix.
 */
export function resolveTurnDisplayMoney(
  turnCost: CostLeaf | null | undefined,
  runCosts: Array<CostLeaf | null | undefined>,
): DisplayMoney | null {
  if (turnCost) {
    const billedCurrency = turnCost.currency || DEFAULT_CURRENCY;
    if (turnCost.total > 0) {
      return {
        nano: turnCost.total,
        estimated: false,
        currency: billedCurrency,
      };
    }
    const est = turnCost.estimated_total;
    if (est != null && est > 0) {
      return {
        nano: est,
        estimated: true,
        currency: turnCost.estimated_currency || billedCurrency,
      };
    }
    // Known zero (platform free / unpriced) — caller gates on nano > 0.
    return { nano: 0, estimated: false, currency: billedCurrency };
  }
  let billed = 0;
  let billedCurrency: string | null = null;
  let estimated = 0;
  let estimatedCurrency: string | null = null;
  for (const c of runCosts) {
    if (!c) continue;
    if (c.total > 0) {
      billed += c.total;
      billedCurrency ??= c.currency || DEFAULT_CURRENCY;
    }
    const est = c.estimated_total ?? 0;
    if (est > 0) {
      estimated += est;
      estimatedCurrency ??=
        c.estimated_currency || c.currency || DEFAULT_CURRENCY;
    }
  }
  if (billed > 0) {
    return {
      nano: billed,
      estimated: false,
      currency: billedCurrency ?? DEFAULT_CURRENCY,
    };
  }
  if (estimated > 0) {
    return {
      nano: estimated,
      estimated: true,
      currency: estimatedCurrency ?? DEFAULT_CURRENCY,
    };
  }
  return null;
}
