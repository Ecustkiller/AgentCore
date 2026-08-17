import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

export type AdminUsageSummary = components["schemas"]["AdminUsageSummary"];
export type AdminGoWindow = components["schemas"]["AdminGoWindow"];
export type AdminGoWindows = components["schemas"]["AdminGoWindows"];
export type AdminUserCostLine = components["schemas"]["AdminUserCostLine"];
export type ModelCostLine = components["schemas"]["ModelCostLine"];
export type UsageWindow = components["schemas"]["UsageWindow"];
export type DailyCost = components["schemas"]["DailyCost"];

/**
 * 全站用量看板: platform-wide today/month totals, the Top spenders by user
 * (工资单 by user), and the 7-day platform trend — the cross-user counterpart of
 * the per-user `/v1/usage/summary`.
 */
export async function fetchUsageSummary(): Promise<AdminUsageSummary> {
  return api.get<AdminUsageSummary>("/v1/admin/usage/summary");
}

/**
 * OpenCode Go 5h / week / month from the platform-prepaid ledger.
 * Nominal nano-CNY plus a public-list USD estimate — neither is an upstream bill.
 */
export async function fetchGoWindows(): Promise<AdminGoWindows> {
  return api.get<AdminGoWindows>("/v1/admin/usage/go-windows");
}
