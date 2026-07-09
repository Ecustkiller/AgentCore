import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import {
  type PendingDelegationAuthorization,
  useDelegationAuthStore,
  type DelegationAuthorizationDecision,
} from "@/stores/delegationAuth";

export type ResolveDelegationAuthorizationBody = {
  kind: "delegation_authorization";
  decision: DelegationAuthorizationDecision;
};

/**
 * Settle delegation-level authorization over the unified interaction bridge.
 *
 * The paused delegate batch resumes with the decision, and the backend emits
 * `delegation_authorization_resolved`. A 404 means the request is stale.
 */
export async function resolveDelegationAuthorization(
  conversationId: string,
  authorizationId: string,
  decision: DelegationAuthorizationDecision,
): Promise<void> {
  await resolveInteraction(conversationId, authorizationId, {
    kind: "delegation_authorization",
    decision,
  });
}

/**
 * Settle one delegation authorization card.
 *
 * On success the card is removed optimistically. `grant_delegation` also records
 * the tool scope so redundant per-call approval cards stay hidden until the
 * turn boundary. A 404 is stale → also removed.
 */
export async function decideDelegationAuthorization(
  authorization: PendingDelegationAuthorization,
  decision: DelegationAuthorizationDecision,
): Promise<void> {
  const store = useDelegationAuthStore.getState();
  store.setResolving(authorization.authorizationId, true);
  try {
    await resolveDelegationAuthorization(
      authorization.conversationId,
      authorization.authorizationId,
      decision,
    );
    if (decision === "grant_delegation") {
      store.recordGrant({
        conversationId: authorization.conversationId,
        executionId: authorization.executionId,
        tools: authorization.tools,
      });
    }
    store.resolve(authorization.authorizationId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      store.resolve(authorization.authorizationId);
      return;
    }
    store.setResolving(authorization.authorizationId, false);
    throw err;
  }
}
