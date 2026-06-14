import type { ApprovalRequiredPayload } from "@/types/events";
import { create } from "zustand";

/**
 * A GRANTABLE tool call paused awaiting the user's decision (CEO chat path).
 *
 * One entry per `approval_required` event, tagged with its `conversationId` so
 * several conversations can hold their own pending prompts at once. Entries are
 * cleared on the matching `approval_resolved`, on a successful/stale resolve, and
 * at the owning conversation's turn boundary (new turn, stop, error, abandon on
 * switch) so a blocked-then-abandoned turn never leaves a dangling prompt — while
 * *other* conversations' prompts survive.
 */
export interface PendingApproval {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** True while a resolve request is in flight — disables the card's buttons so
   * a decision can't be double-submitted. */
  resolving: boolean;
}

interface ApprovalState {
  pending: PendingApproval[];
  /** Record a newly paused tool call. A duplicate id is ignored so a re-delivered
   * event can't stack two cards for one call. */
  add: (payload: ApprovalRequiredPayload) => void;
  /** Drop a settled/stale request (idempotent). */
  remove: (approvalId: string) => void;
  /** Toggle the in-flight flag on one card. */
  setResolving: (approvalId: string, resolving: boolean) => void;
  /**
   * Forget pending requests at a turn boundary. Pass a `conversationId` to drop
   * only that conversation's prompts (leaving other conversations untouched);
   * omit it for a full reset (e.g. logout / tests).
   */
  clear: (conversationId?: string) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  pending: [],

  add: (payload) =>
    set((state) => {
      if (state.pending.some((p) => p.approvalId === payload.approval_id)) {
        return {};
      }
      return {
        pending: [
          ...state.pending,
          {
            approvalId: payload.approval_id,
            conversationId: payload.conversation_id,
            toolCallId: payload.tool_call_id,
            toolName: payload.tool_name,
            arguments: payload.arguments,
            resolving: false,
          },
        ],
      };
    }),

  remove: (approvalId) =>
    set((state) => ({
      pending: state.pending.filter((p) => p.approvalId !== approvalId),
    })),

  setResolving: (approvalId, resolving) =>
    set((state) => ({
      pending: state.pending.map((p) =>
        p.approvalId === approvalId ? { ...p, resolving } : p,
      ),
    })),

  clear: (conversationId) =>
    set((state) =>
      conversationId === undefined
        ? { pending: [] }
        : {
            pending: state.pending.filter(
              (p) => p.conversationId !== conversationId,
            ),
          },
    ),
}));
