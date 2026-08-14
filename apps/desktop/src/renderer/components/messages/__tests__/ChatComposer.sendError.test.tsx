// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../ChatComposer";

let sendError: string | null = null;

vi.mock("@/stores/messaging", () => {
  const clearSendError = vi.fn();
  const loadMembers = vi.fn();
  return {
    useMessagingStore: (sel: (s: Record<string, unknown>) => unknown) =>
      sel({
        sendError,
        clearSendError,
        loadMembers,
      }),
    useActiveChat: () => null,
    useChatMembers: () => [],
  };
});

vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: null }) => unknown) => sel({ user: null }),
}));

afterEach(() => {
  cleanup();
  sendError = null;
});

describe("ChatComposer send-error chrome", () => {
  it("uses noticeChipNeutral for a recoverable send failure (never destructive)", () => {
    sendError = "发送失败，请重试";
    render(<ChatComposer chatId="c1" />);
    const banner = screen.getByTestId("im-composer-send-error");
    expect(banner.className).toContain("bg-muted/40");
    expect(banner.className).not.toContain("destructive");
  });
});
