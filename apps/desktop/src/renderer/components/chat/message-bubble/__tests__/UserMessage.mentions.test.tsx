// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/stores/conversation";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessage } from "../UserMessage";

vi.mock("@/stores/conversation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/conversation")>();
  return {
    ...actual,
    useActiveGenerating: () => false,
    useConversationStore: (
      sel: (s: { currentConversationId: string | null }) => unknown,
    ) => sel({ currentConversationId: "c1" }),
  };
});

afterEach(() => {
  cleanup();
});

function userMsg(over: Partial<Message> = {}): Message {
  return {
    id: "u1",
    role: "user",
    content: "帮我调研",
    createdAt: "2026-01-01T00:00:00Z",
    executionId: null,
    isStreaming: false,
    ...over,
  };
}

describe("UserMessage agent mention chips", () => {
  it("replays persisted @ role chips on the history bubble", () => {
    render(
      <TooltipProvider>
        <UserMessage
          message={userMsg({
            agentMentions: [{ agentId: "w1", role: "研究员" }],
          })}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText("研究员")).toBeTruthy();
    expect(screen.getByText("点名")).toBeTruthy();
    expect(screen.getByText("帮我调研")).toBeTruthy();
  });
});
