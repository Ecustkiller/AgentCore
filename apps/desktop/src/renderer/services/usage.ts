import { api } from "@/services/api";
import type {
  CostBreakdown as LedgerCost,
  UsageBreakdown,
} from "@/types/events";

/**
 * Cost & usage REST surface — the read side of the「团队工资单 / 对话累计 /
 * 账户仪表盘」(§三 / §七). Types mirror the backend Pydantic schemas in
 * ``api/schemas.py`` one-for-one; money is always integer nano-USD (1 USD = 1e9)
 * and the server attaches the display CNY value so the client never re-prices.
 *
 * The ledger (``cost_events``) is the truth source for spend, so these reads are
 * what replay a past turn's payroll / a conversation's running total on reload
 * (the streamed ``run_completed.cost`` / ``message_end.cost`` light them up live).
 */

export type { UsageBreakdown };

/**
 * The REST cost shape = the ledger cost (`types/events.ts` `CostBreakdown`) plus
 * the server-computed CNY display value. The SSE variant omits `cny_total` (the
 * client converts live via the single FX rate); the REST variant carries it.
 */
export interface CostBreakdown extends LedgerCost {
  /** Display-only CNY (元), converted server-side via the single CNY_PER_USD. */
  cny_total: number;
}

/** One participant's row in the team payroll (one Run = one Agent). */
export interface AgentCostLine {
  run_id: string;
  agent_id: string | null;
  role: string;
  model: string;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  duration_ms: number;
}

/** A turn's cost + per-Agent payroll (`GET /v1/messages/{id}/cost`, 工资单). */
export interface TurnCost {
  message_id: string;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  rounds: number;
  agents: AgentCostLine[];
}

/** A conversation's cumulative spend (`GET /v1/conversations/{id}/cost`). */
export interface ConversationCost {
  conversation_id: string;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  turns: number;
}

/** Aggregated usage over a time window (today / month). */
export interface UsageWindow {
  usage: UsageBreakdown;
  cost: CostBreakdown;
  /** Distinct assistant turns in the window (the quota's「请求」proxy). */
  requests: number;
}

/** Free-tier limits (决策④); 0 = unlimited. Money is USD nano internally. */
export interface QuotaStatus {
  daily_tokens: number;
  monthly_cost_nano: number;
  daily_requests: number;
}

/** Account dashboard payload (`GET /v1/usage/summary`). */
export interface UsageSummary {
  today: UsageWindow;
  month: UsageWindow;
  quota: QuotaStatus;
  /** Single server-owned USD→CNY rate; the client formats money from this. */
  cny_per_usd: number;
}

/** Account dashboard: today's tokens/cost, the month's cost, the quota + FX. */
export function getUsageSummary(): Promise<UsageSummary> {
  return api.get<UsageSummary>("/v1/usage/summary");
}

/** A conversation's cumulative spend (对话累计 chip). */
export function getConversationCost(
  conversationId: string,
): Promise<ConversationCost> {
  return api.get<ConversationCost>(`/v1/conversations/${conversationId}/cost`);
}

/** The team payroll for one assistant turn (工资单), rebuilt from the ledger. */
export function getMessageCost(messageId: string): Promise<TurnCost> {
  return api.get<TurnCost>(`/v1/messages/${messageId}/cost`);
}
