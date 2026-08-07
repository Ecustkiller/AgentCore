import type { ChatMessageDetail } from "@/services/messaging";
import { describe, expect, it } from "vitest";
import { detailFromMessage } from "../ProductNoticeDetail";
import {
  SERVICE_DETAIL_BODY_CHARS,
  asProductNoticePayload,
  findProductNoticeMessage,
  productNoticeDetailPath,
  resolveCardTemplate,
  serviceBodyNeedsDetail,
  splitNoticeContent,
} from "../productNotice";

function noticeMessage(
  over: Partial<ChatMessageDetail> & {
    payload?: ChatMessageDetail["payload"];
    content?: string | null;
  },
): ChatMessageDetail {
  return {
    id: over.id ?? "m1",
    chat_id: over.chat_id ?? "official-1",
    content: over.content ?? "标题\n正文",
    content_type: "system_card",
    created_at: over.created_at ?? "2026-08-07T10:00:00Z",
    sender_type: "official",
    sender_user_id: null,
    payload: over.payload ?? { kind: "product_notice", notice_id: "n1" },
    ...over,
  };
}

describe("productNotice model", () => {
  it("treats missing card_template as service (legacy payload)", () => {
    const payload = asProductNoticePayload({
      kind: "product_notice",
      notice_id: "n1",
      severity: "high",
    });
    expect(payload).not.toBeNull();
    if (payload == null) return;
    expect(resolveCardTemplate(payload)).toBe("service");
  });

  it("resolves explicit article template only", () => {
    expect(
      resolveCardTemplate({
        kind: "product_notice",
        card_template: "article",
      }),
    ).toBe("article");
    expect(
      resolveCardTemplate({
        kind: "product_notice",
        card_template: "unknown",
      }),
    ).toBe("service");
  });

  it("splits title\\nbody content", () => {
    expect(splitNoticeContent("发版预告\n今晚 22:00 维护")).toEqual({
      title: "发版预告",
      body: "今晚 22:00 维护",
    });
    expect(splitNoticeContent("只有标题")).toEqual({
      title: "只有标题",
      body: "",
    });
  });

  it("offers detail only for long service body", () => {
    expect(serviceBodyNeedsDetail("短")).toBe(false);
    expect(
      serviceBodyNeedsDetail("x".repeat(SERVICE_DETAIL_BODY_CHARS + 1)),
    ).toBe(true);
  });

  it("builds in-app detail path", () => {
    expect(productNoticeDetailPath("c1", "n1")).toBe("/messages/c1/notices/n1");
  });

  it("finds product_notice message by notice_id", () => {
    const hit = noticeMessage({
      id: "m2",
      payload: { kind: "product_notice", notice_id: "n-hit" },
    });
    const list = [
      noticeMessage({
        id: "m1",
        payload: { kind: "product_notice", notice_id: "other" },
      }),
      hit,
    ];
    expect(findProductNoticeMessage(list, "n-hit")?.id).toBe("m2");
    expect(findProductNoticeMessage(list, "missing")).toBeNull();
  });
});

describe("detailFromMessage", () => {
  it("maps cover / cta / body for detail view", () => {
    const view = detailFromMessage(
      noticeMessage({
        content: "图文标题\n完整正文",
        payload: {
          kind: "product_notice",
          notice_id: "n1",
          card_template: "article",
          cover_url: "https://cdn.example.com/a.jpg",
          cta_label: "检查更新",
          cta_url: "#/more/about",
          severity: "normal",
        },
      }),
    );
    expect(view).toEqual({
      title: "图文标题",
      body: "完整正文",
      severity: "normal",
      coverUrl: "https://cdn.example.com/a.jpg",
      ctaLabel: "检查更新",
      ctaUrl: "#/more/about",
      createdAt: "2026-08-07T10:00:00Z",
    });
  });

  it("omits fake cover when cover_url absent", () => {
    const view = detailFromMessage(
      noticeMessage({
        payload: {
          kind: "product_notice",
          notice_id: "n1",
          card_template: "article",
        },
      }),
    );
    expect(view?.coverUrl).toBeNull();
  });
});
