// @vitest-environment jsdom
/**
 * Official product_notice dual-template cards (service / article).
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatMessageDetail } from "@/services/messaging";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ProductNoticeCard } from "../ProductNoticeCard";
import type { ProductNoticePayload } from "../productNotice";
import { SERVICE_DETAIL_BODY_CHARS } from "../productNotice";

afterEach(cleanup);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderCard(
  message: ChatMessageDetail,
  payload: ProductNoticePayload,
  initial = "/messages/official-1",
) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route
            path="/messages/:chatId"
            element={
              <>
                <ProductNoticeCard message={message} payload={payload} />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/messages/:chatId/notices/:noticeId"
            element={<LocationProbe />}
          />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

function baseMessage(over: Partial<ChatMessageDetail> = {}): ChatMessageDetail {
  return {
    id: "m1",
    chat_id: "official-1",
    content: "发版预告\n今晚维护，预计 30 分钟",
    content_type: "system_card",
    created_at: "2026-08-07T10:00:00Z",
    sender_type: "official",
    sender_user_id: null,
    payload: null,
    ...over,
  };
}

describe("ProductNoticeCard", () => {
  it("renders service card with body readable on the face (legacy payload)", () => {
    const payload: ProductNoticePayload = {
      kind: "product_notice",
      notice_id: "n1",
      severity: "high",
    };
    renderCard(baseMessage(), payload);
    expect(screen.getByText("发版预告")).toBeTruthy();
    expect(screen.getByText("今晚维护，预计 30 分钟")).toBeTruthy();
    expect(screen.getByText("重要")).toBeTruthy();
    expect(screen.queryByText("阅读全文")).toBeNull();
    expect(screen.queryByText("完整说明")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("offers 完整说明 only when service body is long", () => {
    const longBody = "L".repeat(SERVICE_DETAIL_BODY_CHARS + 8);
    const payload: ProductNoticePayload = {
      kind: "product_notice",
      notice_id: "n-long",
      card_template: "service",
    };
    renderCard(baseMessage({ content: `长文标题\n${longBody}` }), payload);
    expect(screen.getByText("完整说明")).toBeTruthy();
    fireEvent.click(screen.getByText("完整说明"));
    expect(screen.getByTestId("loc").textContent).toBe(
      "/messages/official-1/notices/n-long",
    );
  });

  it("article without cover uses severity bar (no fake cover img)", () => {
    const payload: ProductNoticePayload = {
      kind: "product_notice",
      notice_id: "n-art",
      card_template: "article",
      summary: "卡面摘要一行",
      severity: "normal",
    };
    renderCard(baseMessage({ content: "图文标题\n正文很长" }), payload);
    expect(screen.getByText("图文标题")).toBeTruthy();
    expect(screen.getByText("卡面摘要一行")).toBeTruthy();
    expect(screen.getByText("阅读全文")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("一般")).toBeTruthy();
  });

  it("article with cover renders img and 阅读全文 deep link", () => {
    const payload: ProductNoticePayload = {
      kind: "product_notice",
      notice_id: "n-cover",
      card_template: "article",
      summary: "摘要",
      cover_url: "https://cdn.example.com/cover.jpg",
    };
    renderCard(baseMessage({ content: "有封面\n正文" }), payload);
    const img = document.querySelector(
      'img[src="https://cdn.example.com/cover.jpg"]',
    );
    expect(img).toBeTruthy();
    fireEvent.click(screen.getByText("阅读全文"));
    expect(screen.getByTestId("loc").textContent).toBe(
      "/messages/official-1/notices/n-cover",
    );
  });
});
