import { ConversationChangesPanel } from "@/components/workspace/ConversationChangesPanel";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import type { Message } from "@/stores/conversation/types";
import { useExecutionStore } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useLocalTurnBaselineIds } = vi.hoisted(() => ({
  useLocalTurnBaselineIds: vi.fn((): ReadonlySet<string> => new Set()),
}));

vi.mock("@/hooks/useLocalTurnBaselineIds", () => ({
  useLocalTurnBaselineIds,
}));

vi.mock("@/components/chat/TurnFileChangesReview", () => ({
  TurnFileChangesReview: ({
    messageId,
    artifacts,
  }: {
    messageId?: string | null;
    artifacts: unknown[];
  }) => (
    <div data-testid={`review-${messageId}`}>artifacts:{artifacts.length}</div>
  ),
}));

function assistant(id: string, content = "ok"): Message {
  return {
    id,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    executionId: null,
    isStreaming: false,
  };
}

describe("ConversationChangesPanel P0c entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLocalTurnBaselineIds.mockReturnValue(new Set());
    useExecutionStore.setState({ byId: {} });
    useSidePanelStore.setState({ changesFocusMessageId: null });
    useConversationStore.setState({
      currentConversationId: "c1",
      byId: {
        c1: {
          ...EMPTY_RUNTIME,
          messages: [
            {
              id: "u1",
              role: "user",
              content: "hi",
              createdAt: new Date().toISOString(),
              executionId: null,
              isStreaming: false,
            },
            assistant("a-baseline-only", "script deleted tree"),
            assistant("a-no-baseline", "plain reply"),
          ],
        },
      },
    });
  });

  afterEach(cleanup);

  it("lists baseline-only turns without file_* artifacts", async () => {
    useLocalTurnBaselineIds.mockReturnValue(new Set(["a-baseline-only"]));

    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("review-a-baseline-only")).toBeTruthy();
    });
    expect(screen.getByText("回合 1")).toBeTruthy();
    expect(screen.queryByTestId("review-a-no-baseline")).toBeNull();
    expect(screen.getByTestId("review-a-baseline-only").textContent).toContain(
      "artifacts:0",
    );
  });

  it("empty state when neither artifacts nor baselines", () => {
    render(<ConversationChangesPanel />);
    expect(screen.getByText("暂无改动")).toBeTruthy();
    expect(screen.getByText(/可恢复的回合基线/)).toBeTruthy();
  });
});
