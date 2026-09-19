// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/stores/conversation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/conversation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/conversation")>();
  return {
    ...actual,
    useConversationStore: (
      sel: (s: { currentConversationId: string | null }) => unknown,
    ) => sel({ currentConversationId: "conv-1" }),
    getActiveRuntime: () => ({ messages: [] }),
    assistantProjectionId: (m: { id: string }) => m.id,
  };
});

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn(async () => true),
}));

vi.mock("@/lib/toast", () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock("@/hooks/useConversations", () => ({
  useDuplicateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/services/messages", () => ({
  setMessageFeedback: vi.fn(),
}));

import {
  AssistantMessageFooter,
  AssistantMessageMetaSummary,
  MessageMoreMenu,
} from "../AssistantMessageFooter";

const message: Message = {
  id: "asst-1",
  role: "assistant",
  content: "",
  createdAt: "2026-08-05T00:00:00Z",
  executionId: "exec-1",
  isStreaming: false,
  traceId: "trace-1",
};

afterEach(() => {
  cleanup();
});

describe("MessageMoreMenu 复制排查包", () => {
  it("打开更多后露出复制排查包", async () => {
    render(
      <TooltipProvider>
        <MessageMoreMenu message={message} captainContext={[]} />
      </TooltipProvider>,
    );
    const more = screen.getByRole("button", { name: "更多" });
    fireEvent.pointerDown(more);
    expect(
      await screen.findByRole("menuitem", { name: "复制排查包" }),
    ).toBeTruthy();
  });
});

describe("气泡脚不挂轮次", () => {
  it("meta summary 只有费用和用时，没有 N 轮", () => {
    render(
      <AssistantMessageMetaSummary costText="¥1.00" durationMs={12_000} />,
    );
    expect(screen.getByText("¥1.00")).toBeTruthy();
    expect(screen.getByText("12s")).toBeTruthy();
    expect(screen.queryByText(/用时/)).toBeNull();
    expect(screen.queryByText(/轮/)).toBeNull();
  });

  it("更多 · 用量详情仍展示 ReAct 轮次", async () => {
    render(
      <TooltipProvider>
        <MessageMoreMenu
          message={{
            ...message,
            rounds: 3,
            usage: {
              input: 100,
              output: 50,
              reasoning: 0,
              cache_hit: 0,
              cache_miss: 0,
            },
          }}
          captainContext={[]}
        />
      </TooltipProvider>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "更多" }));
    expect(await screen.findByText("ReAct 轮次")).toBeTruthy();
    expect(screen.getByText("3 轮")).toBeTruthy();
  });

  it("更多 · 用量详情展示输出速度", async () => {
    render(
      <TooltipProvider>
        <MessageMoreMenu
          message={{
            ...message,
            generationMs: 2_000,
            usage: {
              input: 100,
              output: 80,
              reasoning: 0,
              cache_hit: 0,
              cache_miss: 0,
            },
          }}
          captainContext={[]}
        />
      </TooltipProvider>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "更多" }));
    expect(await screen.findByText("输出速度")).toBeTruthy();
    expect(screen.getByText("40/秒")).toBeTruthy();
  });

  it("更多 · 缺 generationMs 不编输出速度", async () => {
    render(
      <TooltipProvider>
        <MessageMoreMenu
          message={{
            ...message,
            usage: {
              input: 100,
              output: 80,
              reasoning: 0,
              cache_hit: 0,
              cache_miss: 0,
            },
          }}
          captainContext={[]}
        />
      </TooltipProvider>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "更多" }));
    expect(await screen.findByText("输出")).toBeTruthy();
    expect(screen.queryByText("输出速度")).toBeNull();
  });
});

describe("AssistantMessageFooter regenerate gate", () => {
  const body: Message = {
    ...message,
    content: "半成品答案",
  };

  it("showRegenerate 时露出重新生成", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <AssistantMessageFooter
            message={body}
            captainContext={[]}
            costText={null}
            onRegenerate={() => {}}
            showRegenerate
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeTruthy();
  });

  it("具名恢复：复制仍在，不挂重新生成", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <AssistantMessageFooter
            message={body}
            captainContext={[]}
            costText={null}
            onRegenerate={() => {}}
            showRegenerate={false}
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "有帮助" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
  });
});
