// Conversation share links (所见即所享 · 只读公开页) — mobile Bearer client.
//
// Paths match desktop `/v1/conversations/{id}/shares`. The public page is
// `/shared/{id}` on the API host; production nginx only proxies `/api/` to
// the backend, so the copied URL must keep the `/api` prefix.
import { BASE_URL, apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** One public read-only share (分享链接). `url` is a relative `/shared/<id>`. */
export type Share = Schemas["ShareSummary"];
type ShareListResponse = Schemas["ShareListResponse"];

export type CreateShareOptions = {
  /** 7 / 30 days, or null for never expires. */
  expires_in_days: 7 | 30 | null;
};

/** Absolute URL for a share. Already-absolute `url` values pass through. */
export function shareLink(share: Pick<Share, "url">): string {
  return share.url.startsWith("/") ? `${BASE_URL}${share.url}` : share.url;
}

/** List the conversation's active (un-revoked) share links, newest first. */
export async function listShares(conversationId: string): Promise<Share[]> {
  const path = `/v1/conversations/${encodeURIComponent(conversationId)}/shares`;
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`加载分享链接失败 (${res.status})`);
  const body = (await res.json()) as ShareListResponse;
  return body.data;
}

/** Mint a new snapshot link. Later turns never appear on this URL. */
export async function createShare(
  conversationId: string,
  options: CreateShareOptions,
): Promise<Share> {
  const path = `/v1/conversations/${encodeURIComponent(conversationId)}/shares`;
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) throw new Error(`创建分享链接失败 (${res.status})`);
  return (await res.json()) as Share;
}

/** Revoke a share — its public page 404s immediately afterwards. */
export async function revokeShare(
  conversationId: string,
  shareId: string,
): Promise<void> {
  const cid = encodeURIComponent(conversationId);
  const sid = encodeURIComponent(shareId);
  const path = `/v1/conversations/${cid}/shares/${sid}`;
  const res = await apiFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(`撤销分享链接失败 (${res.status})`);
}
