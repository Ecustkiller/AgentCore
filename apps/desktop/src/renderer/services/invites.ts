import { api } from "@/services/api";

export type InviteStatus = "active" | "used" | "expired";

export interface Invite {
  id: string;
  code: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
}

interface BackendInvite {
  id: string;
  code: string;
  status: InviteStatus;
  created_by: string | null;
  used_by: string | null;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
}

function toInvite(i: BackendInvite): Invite {
  return {
    id: i.id,
    code: i.code,
    status: i.status,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    usedAt: i.used_at,
  };
}

/** Mint a single-use invite code (admin only). */
export async function createInvite(expiresInDays?: number): Promise<Invite> {
  return toInvite(
    await api.post<BackendInvite>("/v1/auth/invites", {
      expires_in_days: expiresInDays ?? null,
    }),
  );
}

interface InviteListResponse {
  data: BackendInvite[];
  total: number;
}

/** List recently issued invite codes (admin only). */
export async function listInvites(): Promise<Invite[]> {
  const res = await api.get<InviteListResponse>("/v1/auth/invites");
  return res.data.map(toInvite);
}
