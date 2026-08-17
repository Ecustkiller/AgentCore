// @vitest-environment jsdom
import type { ConversationSummary } from "@/api/conversations";
import { ActionSheet } from "@/components/conversations";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "c1",
    title: "周报",
    archived: false,
    context_compacted: false,
    created_at: "2026-01-01T00:00:00Z",
    deep_research_auto: false,
    message_count: 0,
    pinned: false,
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

afterEach(cleanup);

function renderSheet(over: Partial<Parameters<typeof ActionSheet>[0]> = {}) {
  const onShare = over.onShare;
  render(
    <ActionSheet
      conv={conv()}
      archivedView={false}
      onClose={vi.fn()}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      {...over}
    />,
  );
  return { onShare };
}

describe("ActionSheet · 分享", () => {
  it("shows 分享 on the live list only when onShare is provided", () => {
    const onShare = vi.fn();
    renderSheet({ onShare });
    fireEvent.click(screen.getByRole("button", { name: "分享" }));
    expect(onShare).toHaveBeenCalled();
  });

  it("hides 分享 when onShare is omitted", () => {
    renderSheet();
    expect(screen.queryByRole("button", { name: "分享" })).toBeNull();
  });

  it("hides 分享 in the archived view even with onShare", () => {
    renderSheet({ archivedView: true, onShare: vi.fn() });
    expect(screen.queryByRole("button", { name: "分享" })).toBeNull();
  });
});
