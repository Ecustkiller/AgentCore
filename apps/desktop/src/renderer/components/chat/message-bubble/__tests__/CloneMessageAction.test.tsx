// @vitest-environment jsdom
/**
 * 助手底栏克隆对话：截到本条，原对话不动；一点即发，无二次确认。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  switchConversation: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock("@/hooks/useConversations", () => ({
  useDuplicateConversation: () => ({
    mutate: mocks.mutate,
    isPending: false,
  }),
}));

vi.mock("@/stores/conversation", () => ({
  useConversationStore: (
    sel: (s: {
      currentConversationId: string | null;
      switchConversation: (id: string) => void;
    }) => unknown,
  ) =>
    sel({
      currentConversationId: "conv-1",
      switchConversation: mocks.switchConversation,
    }),
}));

vi.mock("@/lib/toast", () => ({
  notifyError: (...args: unknown[]) => mocks.notifyError(...args),
}));

import { CloneMessageAction } from "../MessageActions";

afterEach(() => {
  cleanup();
  mocks.mutate.mockReset();
  mocks.switchConversation.mockReset();
  mocks.notifyError.mockReset();
});

describe("CloneMessageAction", () => {
  it("点击即按本条截止克隆，不进入确认态", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <CloneMessageAction messageId="asst-1" />
        </TooltipProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "克隆对话" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith(
      { id: "conv-1", untilMessageId: "asst-1" },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    expect(screen.queryByRole("button", { name: "确认重新生成" })).toBeNull();
  });
});
