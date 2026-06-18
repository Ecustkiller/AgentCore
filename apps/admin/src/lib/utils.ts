import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className merge (last conflicting utility wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Money in CNY (元) from the server-provided value (the backend owns the single
 * FX rate, so the client never re-prices). Tiny non-zero spend floors to
 * "<¥0.01" so a real-but-rounding-to-zero cost never reads as free.
 */
export function fmtCny(yuan: number): string {
  if (yuan > 0 && yuan < 0.01) return "<¥0.01";
  return `¥${yuan.toFixed(2)}`;
}

const COMPACT = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact formatting for large counts (e.g. token totals): 2100000 → "210万". */
export function fmtCompact(n: number): string {
  return COMPACT.format(n);
}

/** Plain integer with thousands separators. */
export function fmtInt(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** Milliseconds, compacted: <1s stays "840ms", ≥1s becomes "2.4s". */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** ISO date "2026-06-18" → "06-18" for compact trend-chart axes. */
export function mmdd(iso: string): string {
  const [, m, d] = iso.split("-");
  return m && d ? `${m}-${d}` : iso;
}

/** ISO timestamp → "MM-DD HH:mm" in the viewer's local zone (compact log axis). */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const NANO_PER_USD = 1_000_000_000;

/**
 * Convert integer nano-USD (the ledger's canonical money unit) to CNY (元) via the
 * single server-provided rate. Used for the raw-nano fields (trend / per-user
 * rows) that don't ship a pre-computed `cny_total` like the window breakdowns do.
 */
export function nanoUsdToCny(nano: number, cnyPerUsd: number): number {
  return (nano / NANO_PER_USD) * cnyPerUsd;
}

/** Integer nano-USD → USD (the unit global quota thresholds are configured in). */
export function nanoUsdToUsd(nano: number): number {
  return nano / NANO_PER_USD;
}
