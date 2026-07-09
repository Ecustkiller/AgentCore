import type {
  DelegationAuthorizationDecision,
  DelegationAuthorizationRequiredPayload,
} from "@/types/events";
import { create } from "zustand";

/**
 * A delegate batch paused awaiting delegation-level tool authorization.
 *
 * One entry per `delegation_authorization_required` event, keyed by
 * `executionId` so a turn's team graph can hold at most one pending card per
 * execution. Cleared on the matching `delegation_authorization_resolved`, on a
 * successful/stale resolve, and at the owning conversation's turn boundary.
 */
export interface PendingDelegationAuthorization {
  authorizationId: string;
  conversationId: string;
  executionId: string;
  workers: DelegationAuthorizationRequiredPayload["workers"];
  tools: string[];
  resolving: boolean;
}

/** Active `grant_delegation` scope for hiding redundant per-call approval cards. */
export interface DelegationGrant {
  conversationId: string;
  executionId: string;
  tools: string[];
}

interface DelegationAuthState {
  pending: PendingDelegationAuthorization[];
  grants: DelegationGrant[];
  add: (payload: DelegationAuthorizationRequiredPayload) => void;
  resolve: (authorizationId: string) => void;
  recordGrant: (grant: DelegationGrant) => void;
  setResolving: (authorizationId: string, resolving: boolean) => void;
  clear: (conversationId?: string) => void;
  isToolGranted: (conversationId: string, toolName: string) => boolean;
}

export const useDelegationAuthStore = create<DelegationAuthState>(
  (set, get) => ({
    pending: [],
    grants: [],

    add: (payload) =>
      set((state) => {
        if (
          state.pending.some(
            (p) =>
              p.authorizationId === payload.authorization_id ||
              p.executionId === payload.execution_id,
          )
        ) {
          return {};
        }
        return {
          pending: [
            ...state.pending,
            {
              authorizationId: payload.authorization_id,
              conversationId: payload.conversation_id,
              executionId: payload.execution_id,
              workers: payload.workers,
              tools: payload.tools,
              resolving: false,
            },
          ],
        };
      }),

    resolve: (authorizationId) =>
      set((state) => ({
        pending: state.pending.filter(
          (p) => p.authorizationId !== authorizationId,
        ),
      })),

    recordGrant: (grant) =>
      set((state) => ({
        grants: [
          ...state.grants.filter(
            (g) =>
              !(
                g.conversationId === grant.conversationId &&
                g.executionId === grant.executionId
              ),
          ),
          grant,
        ],
      })),

    setResolving: (authorizationId, resolving) =>
      set((state) => ({
        pending: state.pending.map((p) =>
          p.authorizationId === authorizationId ? { ...p, resolving } : p,
        ),
      })),

    clear: (conversationId) =>
      set((state) =>
        conversationId === undefined
          ? { pending: [], grants: [] }
          : {
              pending: state.pending.filter(
                (p) => p.conversationId !== conversationId,
              ),
              grants: state.grants.filter(
                (g) => g.conversationId !== conversationId,
              ),
            },
      ),

    isToolGranted: (conversationId, toolName) =>
      get().grants.some(
        (g) =>
          g.conversationId === conversationId && g.tools.includes(toolName),
      ),
  }),
);

export type { DelegationAuthorizationDecision };
