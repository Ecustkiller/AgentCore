import {
  type TurnCost,
  type UsageSummary,
  getConversationCost,
  getMessageCost,
  getUsageSummary,
} from "@/services/usage";
import { create } from "zustand";

/**
 * Account-level usage/cost state — the single front-end home for the FX rate,
 * the dashboard snapshot, and the per-turn payroll cache.
 *
 * `cnyPerUsd` is the one source every `formatCost` call reads, so the UI never
 * hard-codes the rate (§7.2): it is seeded from the backend default and refreshed
 * to the authoritative `settings.cny_per_usd` the moment `/usage/summary` loads.
 */

/** Fallback FX until `/usage/summary` is fetched — only avoids a NaN before the
 * first load. Must stay aligned with the backend default (`settings.cny_per_usd`,
 * 见 `config.py`); the fetched value supersedes it. */
const DEFAULT_CNY_PER_USD = 7.2;

// In-flight message-cost fetches, deduped outside the store so a re-render storm
// of hovers can't fire duplicate requests (and this churn never re-renders).
const inflightMessageCosts = new Set<string>();

/** The 对话累计 chip's data (§7.3C) — only what the caption + its tooltip need,
 * so it sidesteps the REST/SSE cost-shape split: `total` is cumulative nano-USD
 * (the ¥ caption), `tokens` is cumulative input+output (the power tooltip), and
 * `turns` is the assistant-turn count. Seeded from the REST snapshot on open,
 * then folded forward by each turn's `message_end` so the chip stays live. */
export interface ConversationCostSummary {
  total: number;
  tokens: number;
  turns: number;
}

interface UsageState {
  /** USD→CNY display rate; single source for every `formatCost` call. */
  cnyPerUsd: number;
  /** Last account-dashboard snapshot, or null before the first fetch. */
  summary: UsageSummary | null;
  loading: boolean;
  /** User-facing zh error for a failed summary fetch, or null. */
  error: string | null;
  /** Per-turn payroll snapshots from the ledger, keyed by message id — the
   * 回放/回落快照 source for a reloaded turn's cost (live turns carry their own
   * `message.cost`, so they never land here). */
  messageCosts: Record<string, TurnCost>;
  /** Cumulative spend per conversation (对话累计 chip), keyed by conversation id.
   * Seeded from `/conversations/{id}/cost` on open, then bumped live by each
   * turn's `message_end` so the chip updates without a re-fetch. */
  conversationCosts: Record<string, ConversationCostSummary>;

  /** Fetch the account-dashboard summary and refresh the FX rate from it. */
  fetchSummary: () => Promise<void>;
  /** Lazily load + cache a turn's persisted payroll by message id (回落快照).
   * No-op if already cached or in flight; failures are swallowed (cost is
   * supplementary and must never break the chat). */
  loadMessageCost: (messageId: string) => Promise<void>;
  /** Seed a conversation's cumulative spend from the ledger snapshot (对话累计).
   * Overwrites any prior value with the authoritative server total; failures are
   * swallowed (the chip just stays hidden / shows the last value). */
  fetchConversationCost: (conversationId: string) => Promise<void>;
  /** Fold a just-finished turn into a conversation's running total so the chip
   * updates live (回合结束即累加). Initializes the entry if absent. */
  addTurnCost: (conversationId: string, total: number, tokens: number) => void;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  cnyPerUsd: DEFAULT_CNY_PER_USD,
  summary: null,
  loading: false,
  error: null,
  messageCosts: {},
  conversationCosts: {},

  fetchSummary: async () => {
    set({ loading: true, error: null });
    try {
      const summary = await getUsageSummary();
      set({ summary, cnyPerUsd: summary.cny_per_usd, loading: false });
    } catch {
      // A failed dashboard load must never break the chat (用量是附属呈现);
      // keep the last rate and surface a soft error for the dashboard view.
      set({ loading: false, error: "用量加载失败，请重试" });
    }
  },

  loadMessageCost: async (messageId) => {
    if (!messageId) return;
    if (get().messageCosts[messageId] || inflightMessageCosts.has(messageId)) {
      return;
    }
    inflightMessageCosts.add(messageId);
    try {
      const turn = await getMessageCost(messageId);
      set((s) => ({ messageCosts: { ...s.messageCosts, [messageId]: turn } }));
    } catch {
      /* supplementary — a missing payroll just leaves the row without ¥ */
    } finally {
      inflightMessageCosts.delete(messageId);
    }
  },

  fetchConversationCost: async (conversationId) => {
    if (!conversationId) return;
    try {
      const c = await getConversationCost(conversationId);
      set((s) => ({
        conversationCosts: {
          ...s.conversationCosts,
          [conversationId]: {
            total: c.cost.total,
            tokens: c.usage.input + c.usage.output,
            turns: c.turns,
          },
        },
      }));
    } catch {
      /* supplementary — a missing snapshot just keeps the chip hidden */
    }
  },

  addTurnCost: (conversationId, total, tokens) => {
    if (!conversationId) return;
    set((s) => {
      const prev = s.conversationCosts[conversationId] ?? {
        total: 0,
        tokens: 0,
        turns: 0,
      };
      return {
        conversationCosts: {
          ...s.conversationCosts,
          [conversationId]: {
            total: prev.total + total,
            tokens: prev.tokens + tokens,
            turns: prev.turns + 1,
          },
        },
      };
    });
  },
}));
