// @vitest-environment jsdom
/**
 * PermissionAxesBadge — 三档边界；这台电脑仅本机引擎可见。
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useConversations", () => ({
  useConversations: vi.fn(() => []),
  patchConversationCache: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock("@/lib/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capabilities")>();
  return {
    ...actual,
    hasLocalEngine: vi.fn(() => false),
  };
});
vi.mock("@/services/permissionAxes", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/permissionAxes")>();
  return {
    ...actual,
    resolveDefaultPermissionAxes: vi.fn(async () => ({
      boundary: "folder" as const,
    })),
    setUserDefaultRecipe: vi.fn(async (p: string) => p),
    setConversationPermissionAxes: vi.fn(),
    setComposerDraftAxes: vi.fn(),
    confirmComputerIfNeeded: vi.fn(() => true),
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { hasLocalEngine } from "@/lib/capabilities";
import { notifyError, notifySuccess } from "@/lib/toast";
import { setUserDefaultRecipe } from "@/services/permissionAxes";
import { useConversationStore } from "@/stores/conversation";
import { PermissionAxesBadge } from "../PermissionPresetBadge";

const setUserDefaultMock = vi.mocked(setUserDefaultRecipe);

function renderBadge() {
  return render(
    <TooltipProvider>
      <PermissionAxesBadge />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null });
  setUserDefaultMock.mockClear();
  vi.mocked(notifySuccess).mockClear();
  vi.mocked(notifyError).mockClear();
  vi.mocked(hasLocalEngine).mockReturnValue(false);
});

afterEach(cleanup);

describe("PermissionAxesBadge", () => {
  it("sets user default from the current boundary", async () => {
    renderBadge();
    await waitFor(() => {
      expect(screen.getByLabelText("权限：这个文件夹")).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText("权限：这个文件夹"));
    const btn = screen.getByRole("button", { name: "设为新会话默认" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => {
      expect(setUserDefaultMock).toHaveBeenCalledWith("folder");
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringContaining("这个文件夹"),
      );
    });
  });

  it("web hides 这台电脑 and shows 只看 / 这个文件夹", async () => {
    renderBadge();
    await waitFor(() => {
      expect(screen.getByLabelText("权限：这个文件夹")).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText("权限：这个文件夹"));
    expect(screen.getByText("只看")).toBeTruthy();
    expect(screen.getAllByText(/这个文件夹/).length).toBeGreaterThan(0);
    expect(screen.queryByText("这台电脑")).toBeNull();
    expect(screen.queryByText("改某一条")).toBeNull();
    expect(screen.queryByText("谨慎")).toBeNull();
  });

  it("desktop offers 这台电脑", async () => {
    vi.mocked(hasLocalEngine).mockReturnValue(true);
    renderBadge();
    await waitFor(() => {
      expect(screen.getByLabelText("权限：这个文件夹")).toBeTruthy();
    });
    fireEvent.click(screen.getByLabelText("权限：这个文件夹"));
    expect(screen.getByText("这台电脑")).toBeTruthy();
  });
});
