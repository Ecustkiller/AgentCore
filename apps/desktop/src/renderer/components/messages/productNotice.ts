/**
 * Official-chat product_notice dual templates (管理员后台 · 官方号双模板).
 * Payload fields are optional for old IM rows — missing `card_template` → service.
 */

import type { ChatMessageDetail } from "@/services/messaging";

export type ProductNoticeCardTemplate = "service" | "article";

export interface ProductNoticePayload {
  kind: "product_notice";
  notice_id?: string;
  severity?: string;
  card_template?: string;
  summary?: string;
  cover_url?: string;
  cta_label?: string;
  cta_url?: string;
}

export const SEVERITY_LABEL: Record<string, string> = {
  critical: "紧急",
  high: "重要",
  normal: "一般",
};

/** Body longer than this may offer 「完整说明」 without forcing a tap on short ops notices. */
export const SERVICE_DETAIL_BODY_CHARS = 280;

export function asProductNoticePayload(
  payload: ChatMessageDetail["payload"],
): ProductNoticePayload | null {
  if (!payload || typeof payload !== "object") return null;
  if (payload.kind !== "product_notice") return null;
  return payload as unknown as ProductNoticePayload;
}

/** Official publish stores `title\\nbody` in content; degrade when empty. */
export function splitNoticeContent(content: string | null | undefined): {
  title: string;
  body: string;
} {
  const raw = (content ?? "").trim();
  if (!raw) return { title: "[公告]", body: "" };
  const nl = raw.indexOf("\n");
  if (nl === -1) return { title: raw, body: "" };
  return {
    title: raw.slice(0, nl).trim() || "[公告]",
    body: raw.slice(nl + 1).trim(),
  };
}

/** Explicit `card_template` only; unknown / missing → service (old rows). */
export function resolveCardTemplate(
  payload: ProductNoticePayload,
): ProductNoticeCardTemplate {
  return payload.card_template === "article" ? "article" : "service";
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function serviceBodyNeedsDetail(body: string): boolean {
  return body.length > SERVICE_DETAIL_BODY_CHARS;
}

/** In-app deep link: official chat context + notice id. */
export function productNoticeDetailPath(
  chatId: string,
  noticeId: string,
): string {
  return `/messages/${encodeURIComponent(chatId)}/notices/${encodeURIComponent(noticeId)}`;
}

export function findProductNoticeMessage(
  messages: ChatMessageDetail[],
  noticeId: string,
): ChatMessageDetail | null {
  for (const message of messages) {
    if (message.content_type !== "system_card") continue;
    const notice = asProductNoticePayload(message.payload);
    if (!notice) continue;
    if (notice.notice_id === noticeId) return message;
  }
  return null;
}
