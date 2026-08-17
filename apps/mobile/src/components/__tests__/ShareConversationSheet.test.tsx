// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({
    children,
    className,
    label,
  }: {
    children: ReactNode;
    className?: string;
    label?: string;
  }) => (
    <div className={className} aria-label={label}>
      {children}
    </div>
  ),
}));

const listShares = vi.fn();
const createShare = vi.fn();
const revokeShare = vi.fn();
const copyText = vi.fn();

vi.mock("@/api/sharing", () => ({
  listShares: (...args: unknown[]) => listShares(...args),
  createShare: (...args: unknown[]) => createShare(...args),
  revokeShare: (...args: unknown[]) => revokeShare(...args),
  shareLink: (share: { url: string }) =>
    share.url.startsWith("/") ? `http://localhost:8000${share.url}` : share.url,
}));

vi.mock("@/lib/messageExport", () => ({
  copyText: (...args: unknown[]) => copyText(...args),
}));

import { ShareConversationSheet } from "../ShareConversationSheet";

const share = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  url: "/shared/s1",
  title: "周报",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: null,
  ...over,
});

beforeEach(() => {
  listShares.mockReset();
  createShare.mockReset();
  revokeShare.mockReset();
  copyText.mockReset();
  copyText.mockResolvedValue(true);
  listShares.mockResolvedValue([]);
});

afterEach(cleanup);

describe("ShareConversationSheet", () => {
  it("creates a link and copies it", async () => {
    const made = share({ id: "new", url: "/shared/new" });
    createShare.mockResolvedValue(made);

    render(<ShareConversationSheet conversationId="c1" onClose={vi.fn()} />);
    await screen.findByText("还没有分享链接。");

    fireEvent.click(screen.getByRole("button", { name: "创建分享链接" }));

    await waitFor(() => {
      expect(createShare).toHaveBeenCalledWith("c1", { expires_in_days: 30 });
    });
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith("http://localhost:8000/shared/new");
    });
    expect(screen.getByText("http://localhost:8000/shared/new")).toBeTruthy();
    expect(screen.getByText("链接已复制")).toBeTruthy();
  });

  it("revokes an existing link", async () => {
    listShares.mockResolvedValue([share()]);

    render(<ShareConversationSheet conversationId="c1" onClose={vi.fn()} />);
    await screen.findByText("http://localhost:8000/shared/s1");

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() => {
      expect(revokeShare).toHaveBeenCalledWith("c1", "s1");
    });
    await waitFor(() => {
      expect(screen.queryByText("http://localhost:8000/shared/s1")).toBeNull();
    });
    expect(screen.getByText("已撤销")).toBeTruthy();
  });
});
