// Per-turn cost lookup for the mobile client (成本呈现; 团队工资单 read side).
//
// A finished turn's spend is replayed from the cost_events ledger by message_id
// (api/routes 工资单). The LIVE turn already carries its cost in the SSE message_end
// (the fold's ProjectedTurn.cost), so this endpoint is only for RELOADED history — a
// persisted MessageDetail does not carry cost. Supplementary: callers swallow failures
// (cost must never break the chat). REST DTOs track OpenAPI via contract-rest-types.
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

type TurnCost = Schemas["TurnCost"];

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

// --- Account dashboard (设置·用量) ---

export type CostBreakdown = Schemas["CostBreakdown"];
export type UsageBreakdown = Schemas["UsageBreakdown"];
export type UsageWindow = Schemas["UsageWindow"];
export type QuotaStatus = Schemas["QuotaStatus"];
export type RoleCostLine = Schemas["RoleCostLine"];
export type DailyCost = Schemas["DailyCost"];
export type UsageSummary = Schemas["UsageSummary"];

/** Account dashboard: today's tokens/cost, the month's cost, quota + FX rate. */
export async function getUsageSummary(): Promise<UsageSummary> {
  const res = await apiFetch("/v1/usage/summary");
  if (!res.ok) throw new Error(`加载用量失败 (${res.status})`);
  return (await res.json()) as UsageSummary;
}
