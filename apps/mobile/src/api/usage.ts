// Per-turn cost lookup for the mobile client (成本呈现; 团队工资单 read side).
//
// A finished turn's spend is replayed from the cost_events ledger by message_id
// (api/routes 工资单). The LIVE turn already carries its cost in the SSE message_end
// (the fold's ProjectedTurn.cost), so this endpoint is only for RELOADED history — a
// persisted MessageDetail does not carry cost. Supplementary: callers swallow failures
// (cost must never break the chat). Types are a hand-written subset of the backend
// TurnCost schema (schemas.py), matching the skeleton convention in conversations.ts.
import { apiFetch } from "@/api/client";

interface TurnCost {
  message_id: string;
  // Integer nano-USD (1 USD = 1e9); `cny_total` is a server-computed display value.
  cost: { total: number; currency: string; cny_total: number };
}

/**
 * A turn's persisted cost total in integer nano-USD (0 when unmetered / unknown / not
 * owned — the backend never leaks existence). Returns 0 rather than throwing on a non-2xx
 * so a missing payroll just leaves the row without a cost caption.
 */
export async function getMessageCostTotal(messageId: string): Promise<number> {
  try {
    const res = await apiFetch(`/v1/messages/${messageId}/cost`);
    if (!res.ok) return 0;
    const data = (await res.json()) as TurnCost;
    return data.cost?.total ?? 0;
  } catch {
    return 0;
  }
}

// --- Account dashboard (设置·用量) — hand-written subset of UsageSummary (schemas.py). ---

/** Token counts; integer nano-USD cost + server-computed ¥ (`cny_total`, no re-pricing). */
export interface CostBreakdown {
  total: number;
  currency: string;
  cny_total: number;
}
export interface UsageBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache_hit: number;
  cache_miss: number;
}
export interface UsageWindow {
  usage: UsageBreakdown;
  cost: CostBreakdown;
  requests: number;
}
/** Free-tier limits; 0 = unlimited. Money is USD nano internally. */
export interface QuotaStatus {
  daily_tokens: number;
  monthly_cost_nano: number;
  daily_requests: number;
}
/** One role's monthly spend — the team payroll grouped by role (本月各角色花销). */
export interface RoleCostLine {
  role: string;
  cost_total: number;
  turns: number;
}
/** One UTC day's total spend — a point in the 7-day trend. */
export interface DailyCost {
  date: string;
  cost_total: number;
}
export interface UsageSummary {
  today: UsageWindow;
  month: UsageWindow;
  month_by_role: RoleCostLine[];
  recent_daily_cost: DailyCost[];
  quota: QuotaStatus;
  // Single server-owned FX rate so the client formats ¥ without hard-coding it.
  cny_per_usd: number;
  // Present under BYOK so the dashboard reframes 额度 as 自带 Key 不限额.
  billing_mode?: string;
}

/** Account dashboard: today's tokens/cost, the month's cost, quota + FX rate. */
export async function getUsageSummary(): Promise<UsageSummary> {
  const res = await apiFetch("/v1/usage/summary");
  if (!res.ok) throw new Error(`加载用量失败 (${res.status})`);
  return (await res.json()) as UsageSummary;
}
