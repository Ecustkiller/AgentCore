import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

export type Invite = components["schemas"]["InviteResponse"];
export type InviteListResponse = components["schemas"]["InviteListResponse"];
export type InviteStatus = Invite["status"];

/**
 * The full invite roster. Lives under `/v1/auth/invites` (cohesive with register)
 * but is admin-gated — the same authorization boundary as `/v1/admin/*`.
 */
export async function listInvites(): Promise<InviteListResponse> {
  return api.get<InviteListResponse>("/v1/auth/invites");
}

/**
 * Mint a new invite code. `expiresInDays` omitted (or ≤ 0) → a code that never
 * expires (the backend default); a positive number sets the TTL in days.
 */
export async function createInvite(expiresInDays?: number): Promise<Invite> {
  const body =
    expiresInDays && expiresInDays > 0
      ? { expires_in_days: expiresInDays }
      : undefined;
  return api.post<Invite>("/v1/auth/invites", body);
}

/**
 * Burn an *unused* code so it can no longer be registered against. Idempotent it
 * is not — the backend rejects an already-used or already-revoked code (422).
 * Returns the fresh record (now `status: "revoked"`).
 */
export async function revokeInvite(inviteId: string): Promise<Invite> {
  return api.post<Invite>(`/v1/auth/invites/${inviteId}/revoke`);
}
