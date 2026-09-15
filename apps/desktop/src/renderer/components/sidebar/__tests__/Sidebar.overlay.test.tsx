// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../Sidebar";

vi.mock("@/lib/newConversation", () => ({
  startNewConversation: vi.fn(),
}));

vi.mock("@/stores/messaging", () => ({
  useUnreadTotal: () => 0,
}));

vi.mock("../RecentConversations", () => ({
  RecentConversations: () => null,
  ViewAllConversations: () => null,
}));

vi.mock("../PinnedConversations", () => ({
  PinnedConversations: () => null,
}));

vi.mock("../WorkspaceGroups", () => ({
  WorkspaceGroups: () => null,
}));

vi.mock("../UserMenu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

vi.mock("@/lib/capabilities", () => ({
  isWebClient: () => false,
}));

vi.mock("@/lib/railHotkeys", () => ({
  RailHotkeySlotsProvider: ({
    children,
  }: {
    children: ReactNode;
  }) => children,
}));

function renderOverlay(onDismiss = vi.fn()) {
  return {
    onDismiss,
    ...render(
      <MemoryRouter>
        <TooltipProvider>
          <Sidebar overlay onDismiss={onDismiss} />
        </TooltipProvider>
      </MemoryRouter>,
    ),
  };
}

afterEach(() => {
  cleanup();
});

describe("Sidebar · overlay", () => {
  it("reuses desktop nav minus toolbox and closes from the header", () => {
    const { onDismiss } = renderOverlay();

    expect(screen.getByRole("dialog", { name: "侧栏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新对话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "文件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "消息" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "工具箱" })).toBeNull();
    expect(screen.queryByRole("button", { name: "折叠侧栏" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭侧栏" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses when a nav row is activated", () => {
    const { onDismiss } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
