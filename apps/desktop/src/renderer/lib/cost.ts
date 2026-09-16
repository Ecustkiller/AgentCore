/**
 * Pure cost-derivation helper for the turn cost row (§7.3A). Framework-free on
 * purpose: the money math lives here so it is unit-testable without a DOM, and
 * the components only render the result. (Per-Agent money now shows directly on
 * each graph node from `run.cost`, §7.3B — no payroll split needed.)
 *
 * Money is integer nano throughout (1 unit = 1e9). User-facing amounts are the
 * curated CNY nominal — platform billed and BYOK display copy of the same card.
 * Legacy community-USD estimates still carry `estimated_currency=USD` (≈$).
 * This never re-prices and **never converts**; it only sums already-priced run
 * totals within a single currency.
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
  /** True only for leftover USD community estimates (≈$). CNY is a real bill. */
  estimated: boolean;
  /** ISO code of {@link nano}. Renderers pick the symbol from this, never guess. */
  currency: string;
};

/** 无 FX：跨币种金额不可相加，所以合计只在同一币种内累加。 */
const DEFAULT_CURRENCY = "CNY";

function isUsdEstimate(currency: string): boolean {
  return currency.toUpperCase() === "USD";
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

function displayFromEstimate(nano: number, currency: string): DisplayMoney {
  return {
    nano,
    estimated: isUsdEstimate(currency),
    currency,
  };
}

/**
 * Turn display money: `total` (product nominal, CNY) wins; else `estimated_total`
 * (BYOK slice, or legacy USD). Null = nothing to show.
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
      return displayFromEstimate(
        est,
        turnCost.estimated_currency || billedCurrency,
      );
    }
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
    return displayFromEstimate(
      estimated,
      estimatedCurrency ?? DEFAULT_CURRENCY,
    );
  }
  return null;
}
