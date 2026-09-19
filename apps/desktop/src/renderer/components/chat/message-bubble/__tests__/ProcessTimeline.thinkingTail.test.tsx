// @vitest-environment jsdom
/**
 * In-stream Thinking… tail: `shouldShowThinkingTail` is the exported gate.
 * Live chrome (running/wait tool, streaming reasoning/content,
 * composing tool, visible graph at tail, pending user gate) suppresses the tail.
 * The team marker is not live by itself.
 */
import {
  ProcessTimeline,
  graphSlotExecutionId,
  shouldShowThinkingTail,
} from "@/components/chat/message-bubble/ProcessTimeline";
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
};

const toolDone: ProcessStep = {
  kind: "tool",
  id: "t1",
  tool_name: "web_search",
  arguments: {},
  result: null,
  status: "success",
};
const toolRunning: ProcessStep = { ...toolDone, status: "running" };
const toolError: ProcessStep = { ...toolDone, status: "error" };
const waitDone: ProcessStep = { ...toolDone, tool_name: "wait" };
const waitRunning: ProcessStep = { ...waitDone, status: "running" };
const team: ProcessStep = { kind: "team", execution_id: "e1" };
const leftoverPlanReview = {
  kind: "plan_review",
  checkpoint_id: "pr1",
} as unknown as ProcessStep;

const live = {
  isStreaming: true,
  composingTool: false,
  graphVisibleAtTail: false,
  pendingUserGate: false,
};

describe("graphSlotExecutionId", () => {
  it("resolves the team marker as the graph slot", () => {
    expect(graphSlotExecutionId(team)).toBe("e1");
  });

  it("resolves nothing for non-slot tails", () => {
    expect(graphSlotExecutionId(undefined)).toBeNull();
    expect(graphSlotExecutionId(toolDone)).toBeNull();
    expect(graphSlotExecutionId(leftoverPlanReview)).toBeNull();
  });
});

describe("shouldShowThinkingTail", () => {
  it("suppresses when not streaming, composing a tool, a user gate is pending, or the graph is live at the tail", () => {
    expect(
      shouldShowThinkingTail({ ...live, last: team, isStreaming: false }),
    ).toBe(false);
    expect(
      shouldShowThinkingTail({ ...live, last: toolDone, composingTool: true }),
    ).toBe(false);
    expect(
      shouldShowThinkingTail({ ...live, last: team, pendingUserGate: true }),
    ).toBe(false);
    expect(
      shouldShowThinkingTail({
        ...live,
        last: team,
        graphVisibleAtTail: true,
      }),
    ).toBe(false);
  });

  it("shows for team tails when the graph is not visible", () => {
    expect(shouldShowThinkingTail({ ...live, last: team })).toBe(true);
    expect(
      shouldShowThinkingTail({
        ...live,
        last: team,
        graphVisibleAtTail: true,
      }),
    ).toBe(false);
    expect(
      shouldShowThinkingTail({
        ...live,
        last: team,
        pendingUserGate: true,
      }),
    ).toBe(false);
    expect(
      shouldShowThinkingTail({
        ...live,
        last: team,
        isStreaming: false,
      }),
    ).toBe(false);
  });

  it("suppresses a running tool, wait (running or settled), and streaming reasoning/content", () => {
    expect(shouldShowThinkingTail({ ...live, last: toolRunning })).toBe(false);
    expect(shouldShowThinkingTail({ ...live, last: waitDone })).toBe(false);
    expect(shouldShowThinkingTail({ ...live, last: waitRunning })).toBe(false);
    expect(
      shouldShowThinkingTail({
        ...live,
        last: { kind: "reasoning", text: "想" },
      }),
    ).toBe(false);
    expect(
      shouldShowThinkingTail({
        ...live,
        last: { kind: "content", text: "答" },
      }),
    ).toBe(false);
  });

  it("shows after a settled non-wait tool, an empty tail, and other markers", () => {
    expect(shouldShowThinkingTail({ ...live, last: toolDone })).toBe(true);
    expect(shouldShowThinkingTail({ ...live, last: toolError })).toBe(true);
    expect(shouldShowThinkingTail({ ...live, last: undefined })).toBe(true);
    expect(shouldShowThinkingTail({ ...live, last: leftoverPlanReview })).toBe(
      true,
    );
  });
});

describe("ProcessTimeline · thinking tail", () => {
  it("paints Thinking… after a team marker when no graph is mounted", () => {
    render(
      <ProcessTimeline
        process={[team]}
        isStreaming
        citations={[]}
        composingTool={null}
        fallbackContent=""
        conversationId="c1"
        {...emptyCards}
      />,
    );
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(document.querySelector("[data-live-flow]")).not.toBeNull();
  });

  it("pins Thought body to the column so a long + chain cannot blow the pane", () => {
    const { container } = render(
      <ProcessTimeline
        process={[
          {
            kind: "reasoning",
            text: `支出总额：${"1000+500+50+".repeat(30)}`,
          },
        ]}
        isStreaming
        citations={[]}
        composingTool={null}
        fallbackContent=""
        conversationId="c1"
        {...emptyCards}
      />,
    );
    const thought = container.querySelector(".process-thought");
    expect(thought?.className).toContain("min-w-0");
    expect(thought?.className).toContain("max-w-full");
    const md = thought?.querySelector(".markdown-body");
    expect(md?.className).toContain("[overflow-wrap:anywhere]");
  });
});
