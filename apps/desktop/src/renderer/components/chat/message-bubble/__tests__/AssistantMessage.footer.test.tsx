// @vitest-environment jsdom
/**
 * Footer 门控：按本条 isStreaming，不按会话 isGenerating。
 * 回归：长生成时已 settle 的旧气泡仍应露出重新生成/费用等操作区。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/stores/conversation";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const genMock = vi.hoisted(() => ({ value: true }));

vi.mock("@/stores/conversation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/conversation")>();
  return {
    ...actual,
    // 若误把门控写回全局 isGenerating，本 mock 恒 true 会藏 footer → 测失败。
    useActiveGenerating: () => genMock.value,
    useConversationStore: (
      sel: (s: { currentConversationId: string | null }) => unknown,
    ) => sel({ currentConversationId: "conv-1" }),
    getActiveRuntime: () => ({ messages: [] }),
    assistantProjectionId: (m: { id: string }) => m.id,
  };
});

vi.mock("@/stores/usage", () => ({
  useUsageStore: (
    sel: (s: {
      loadMessageCost: () => void;
      messageCosts: Record<string, never>;
    }) => unknown,
  ) => sel({ loadMessageCost: () => {}, messageCosts: {} }),
}));

vi.mock("@/stores/execution", () => ({
  useExecutionStore: (
    sel: (s: { byId: Record<string, { deliveryStatus: null }> }) => unknown,
  ) => sel({ byId: {} }),
}));

vi.mock("@/stores/interactions", () => ({
  useMessageInteractionCards: () => ({
    checkpoints: [],
    nonBlockingAsks: [],
    planReviews: [],
    teamPreviews: [],
  }),
}));

vi.mock("@/services/turns", () => ({
  runRegenerate: vi.fn(),
}));

vi.mock("../AssistantMessageFooter", () => ({
  AssistantMessageFooter: () => <div data-testid="assistant-footer" />,
}));

vi.mock("@/components/chat/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("@/components/chat/debate/CollapsibleSpeech", () => ({
  CollapsibleSpeech: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { AssistantMessage } from "../AssistantMessage";

function settledMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "asst-1",
    role: "assistant",
    content: "已完成的旧回复",
    createdAt: "2026-08-05T00:00:00Z",
    executionId: null,
    isStreaming: false,
    ...overrides,
  };
}

function renderBubble(message: Message) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <AssistantMessage message={message} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  genMock.value = true;
});

describe("AssistantMessage footer gate", () => {
  it("本条已 settle 时，即使会话仍 generating 也显示 footer", () => {
    genMock.value = true;
    renderBubble(settledMessage());
    expect(screen.getByTestId("assistant-footer")).toBeTruthy();
  });

  it("本条仍在 streaming 时不显示 footer", () => {
    genMock.value = false;
    renderBubble(settledMessage({ isStreaming: true, content: "流式中…" }));
    expect(screen.queryByTestId("assistant-footer")).toBeNull();
  });

  it("空正文且非失败时不显示 footer", () => {
    renderBubble(settledMessage({ content: "" }));
    expect(screen.queryByTestId("assistant-footer")).toBeNull();
  });

  it("空正文 + message.error 时显示 footer", () => {
    renderBubble(
      settledMessage({
        content: "",
        error: { code: "LLM_ERROR", message: "模型调用失败，请重试。" },
      }),
    );
    expect(screen.getByTestId("assistant-footer")).toBeTruthy();
  });

  it("错误卡不挂重新生成（定案 A；底栏 footer 另测）", () => {
    renderBubble(
      settledMessage({
        content: "",
        error: { code: "LLM_ERROR", message: "模型调用失败，请重试。" },
      }),
    );
    const errText = screen.getByText("模型调用失败，请重试。");
    const errCard = errText.closest("div");
    expect(errCard).toBeTruthy();
    expect(
      within(errCard as HTMLElement).queryByRole("button", {
        name: "重新生成",
      }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    // 本测 mock 了 Footer；只断言错误卡已摘按钮，footer 仍挂载。
    expect(screen.getByTestId("assistant-footer")).toBeTruthy();
  });

  it("空正文 + runs.error 时显示 footer", () => {
    renderBubble(
      settledMessage({
        content: "",
        // Duck-typed journal error only (no message.error / non-synthesizable finish).
        runs: {
          events: [],
          finishReason: "stop",
          error: { code: "LLM_ERROR", message: "上游超时" },
        } as Message["runs"],
      }),
    );
    expect(screen.getByTestId("assistant-footer")).toBeTruthy();
  });

  it("空正文 + 可合成空失败（finishReason=error）时显示 footer", () => {
    renderBubble(settledMessage({ content: "", finishReason: "error" }));
    expect(screen.getByTestId("assistant-footer")).toBeTruthy();
  });

  it("空正文 + cancelled 不占聊天面；interrupted 仍合成脸（P1）", () => {
    renderBubble(settledMessage({ content: "", finishReason: "cancelled" }));
    expect(screen.queryByTestId("assistant-stopped-notice")).toBeNull();
    expect(screen.queryByText("已停止")).toBeNull();
    // No footer on cancelled-alone (timeline omits the stop face).
    expect(screen.queryByTestId("assistant-footer")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制排查包" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
    cleanup();
    // Interrupted: error card only (layer-1 — no footer regenerate).
    renderBubble(settledMessage({ content: "", finishReason: "interrupted" }));
    expect(screen.getByText(/已中断/)).toBeTruthy();
    expect(screen.queryByTestId("assistant-footer")).toBeNull();
    expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
  });
});
