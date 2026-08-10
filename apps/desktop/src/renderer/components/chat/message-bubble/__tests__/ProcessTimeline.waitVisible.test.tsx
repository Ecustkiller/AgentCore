// @vitest-environment jsdom
/**
 * CEO bubble (collapseProcessSteps default true) must show wait tool rows and
 * wait-idle reasoning — omitCoordinationIdleSteps is no longer applied here.
 */
import { ProcessTimeline } from "@/components/chat/message-bubble/ProcessTimeline";
import type { ProcessStep } from "@/types/events";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/disclosure", () => ({
  useStreamAwareDisclosure: () => [true, vi.fn()],
  usePersistentDisclosure: () => [false, vi.fn()],
}));

afterEach(cleanup);

const emptyCards = {
  checkpoints: [] as never[],
  nonBlockingAsks: [] as never[],
  planReviews: [] as never[],
  teamPreviews: [] as never[],
};

function renderTimeline(process: ProcessStep[], isStreaming: boolean) {
  return render(
    <ProcessTimeline
      process={process}
      isStreaming={isStreaming}
      citations={[]}
      composingTool={null}
      fallbackContent=""
      conversationId="c1"
      {...emptyCards}
    />,
  );
}

describe("ProcessTimeline · wait visibility (CEO bubble)", () => {
  it("shows wait tool and wait-idle reasoning under default collapse", () => {
    const process: ProcessStep[] = [
      { kind: "reasoning", text: "空等听团" },
      {
        kind: "tool",
        id: "w1",
        tool_name: "wait",
        arguments: {},
        result: null,
        status: "success",
      },
      { kind: "reasoning", text: "仍在听" },
      { kind: "content", text: "对用户说一句" },
    ];
    renderTimeline(process, false);
    expect(screen.getByText("wait")).toBeTruthy();
    expect(screen.getByText("空等听团")).toBeTruthy();
    expect(screen.getByText("仍在听")).toBeTruthy();
    expect(screen.getByText("对用户说一句")).toBeTruthy();
  });

  it("does not paint Thinking tail after a settled wait while streaming", () => {
    const process: ProcessStep[] = [
      {
        kind: "tool",
        id: "w1",
        tool_name: "wait",
        arguments: {},
        result: null,
        status: "success",
      },
    ];
    renderTimeline(process, true);
    expect(screen.getByText("wait")).toBeTruthy();
    expect(screen.queryByText(/Thinking/i)).toBeNull();
  });
});
