// @vitest-environment jsdom
/**
 * 消息 tab 根页 chrome：标题靠左，右侧「发起」是 icon-btn（不是小字 link）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  getTokens: () => ({ access_token: "a", refresh_token: "r" }),
}));

const { listChats } = vi.hoisted(() => ({
  listChats: vi.fn(),
}));
vi.mock("@/api/messaging", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/messaging")>("@/api/messaging");
  return { ...actual, listChats };
});

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

import { MessagesPage } from "@/pages/MessagesPage";

beforeEach(() => {
  vi.clearAllMocks();
  listChats.mockResolvedValue([]);
});

afterEach(cleanup);

describe("MessagesPage", () => {
  it("keeps the title left and uses an icon-btn for 发起", async () => {
    render(<MessagesPage />);
    expect(screen.getByText("消息")).toBeTruthy();
    expect(document.querySelector(".bar-title")).toBeNull();

    const start = screen.getByRole("button", { name: "发起" });
    expect(start.className).toMatch(/icon-btn/);
    expect(start.textContent).not.toMatch(/发起/);

    fireEvent.click(start);
    expect(navigate).toHaveBeenCalledWith("/im/new");

    expect(
      await screen.findByText("还没有会话。点右上角发起新聊天。"),
    ).toBeTruthy();
  });
});
