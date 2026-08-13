// @vitest-environment jsdom
/**
 * 「本轮内都允许」之后被跳过的调用要留下可见痕迹（零噪音，但可查）：
 * 卡不再弹，痕迹行必须说出「此后 N 次未再问你」，否则用户回看时会以为自己一直在逐个把关。
 */
import { ApprovalTrace } from "@/components/chat/HotDecisionTrace";
import { useConversationStore } from "@/stores/conversation";
import { execRuntime, useExecutionStore } from "@/stores/execution";
import type { InteractionEntry } from "@/stores/interactions";
import { useInteractionStore } from "@/stores/interactions";
import type { ProcessStep } from "@/types/events";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CONVERSATION_ID = "c1";
const MESSAGE_ID = "m1";

function toolStep(id: string, toolName: string): ProcessStep {
  return {
    kind: "tool",
    id,
    tool_name: toolName,
    arguments: {},
    result: null,
    status: "success",
  };
}

function approvalEntry(
  id: string,
  toolName: string,
  decision: string | null,
): InteractionEntry {
  return {
    id,
    kind: "approval",
    status: decision ? "resolved" : "pending",
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    payload: { approval_id: id, tool_call_id: id, tool_name: toolName },
    ...(decision ? { resolution: { decision } } : {}),
  };
}

function seed(entries: InteractionEntry[], process: ProcessStep[]) {
  useInteractionStore.setState({
    byId: new Map(entries.map((e) => [e.id, e])),
  });
  useConversationStore.setState({
    currentConversationId: CONVERSATION_ID,
    byId: {
      [CONVERSATION_ID]: {
        ...useConversationStore.getState().byId[CONVERSATION_ID],
        messages: [
          {
            id: MESSAGE_ID,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            executionId: null,
            isStreaming: false,
            process,
          },
        ],
      },
    },
  } as never);
}

function seedWorkerFrames(
  frames: Array<{ toolCallId: string; toolName: string; runId: string }>,
) {
  const base = execRuntime(useExecutionStore.getState(), "absent");
  useExecutionStore.setState({
    byId: {
      [MESSAGE_ID]: {
        ...base,
        frames: frames.map((f, i) => ({
          t: i + 1,
          kind: "tool_use_start" as const,
          toolCallId: f.toolCallId,
          toolName: f.toolName,
          arguments: {},
          runId: f.runId,
        })),
      },
    },
  });
}

beforeEach(() => {
  useInteractionStore.setState({ byId: new Map() });
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
});

afterEach(cleanup);

describe("ApprovalTrace · 本轮授权的知情痕迹", () => {
  it("说出授权范围，并数出此后没再问的次数", () => {
    seed(
      [approvalEntry("t1", "terminal", "approve_always")],
      [
        toolStep("t1", "terminal"),
        toolStep("t2", "terminal"),
        toolStep("t3", "terminal"),
      ],
    );
    render(<ApprovalTrace approvalId="t1" messageId={MESSAGE_ID} />);
    const text = screen.getByTestId("approval-trace").textContent ?? "";
    expect(text).toContain("本轮内都允许");
    expect(text).toContain("此后 2 次未再问你");
  });

  it("队员发起的调用也算进去（协作图 frame 流）", () => {
    seed(
      [approvalEntry("t1", "terminal", "approve_always")],
      [toolStep("t1", "terminal")],
    );
    seedWorkerFrames([
      { toolCallId: "t1", toolName: "terminal", runId: "" },
      { toolCallId: "w1", toolName: "terminal", runId: "r1" },
      { toolCallId: "w2", toolName: "terminal", runId: "r2" },
    ]);
    render(<ApprovalTrace approvalId="t1" messageId={MESSAGE_ID} />);
    expect(screen.getByTestId("approval-trace").textContent).toContain(
      "此后 2 次未再问你",
    );
  });

  it("文件类授权说出更宽的范围，并覆盖同类其它工具", () => {
    seed(
      [approvalEntry("f1", "file_write", "approve_always_files")],
      [
        toolStep("f1", "file_write"),
        toolStep("f2", "str_replace"),
        toolStep("f3", "file_delete"),
        toolStep("x1", "code_execute"),
      ],
    );
    render(<ApprovalTrace approvalId="f1" messageId={MESSAGE_ID} />);
    const text = screen.getByTestId("approval-trace").textContent ?? "";
    expect(text).toContain("本轮内所有文件改动");
    expect(text).toContain("此后 2 次未再问你");
  });

  it("弹过卡的那些不算被跳过（兄弟卡顺带放行也是问过的）", () => {
    seed(
      [
        approvalEntry("t1", "terminal", "approve_always"),
        approvalEntry("t2", "terminal", "approve"),
      ],
      [
        toolStep("t1", "terminal"),
        toolStep("t2", "terminal"),
        toolStep("t3", "terminal"),
      ],
    );
    render(<ApprovalTrace approvalId="t1" messageId={MESSAGE_ID} />);
    expect(screen.getByTestId("approval-trace").textContent).toContain(
      "此后 1 次未再问你",
    );
  });

  it("一次性批准不谈范围、不谈跳过（没有轮内授权可讲）", () => {
    seed(
      [approvalEntry("t1", "terminal", "approve")],
      [toolStep("t1", "terminal"), toolStep("t2", "terminal")],
    );
    render(<ApprovalTrace approvalId="t1" messageId={MESSAGE_ID} />);
    const text = screen.getByTestId("approval-trace").textContent ?? "";
    expect(text).toContain("已批准");
    expect(text).not.toContain("本轮内");
    expect(text).not.toContain("未再问你");
  });

  it("授权后确实一次没跳过 → 只说范围，不硬凑一个 0", () => {
    seed(
      [approvalEntry("t1", "terminal", "approve_always")],
      [toolStep("t1", "terminal")],
    );
    render(<ApprovalTrace approvalId="t1" messageId={MESSAGE_ID} />);
    const text = screen.getByTestId("approval-trace").textContent ?? "";
    expect(text).toContain("本轮内都允许");
    expect(text).not.toContain("未再问你");
  });
});
