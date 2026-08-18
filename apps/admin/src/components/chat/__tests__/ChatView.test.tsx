// @vitest-environment jsdom
import { ChatView } from "@/components/chat/ChatView";
import type { ProjectedTurn } from "@agentcore/protocol-conformance";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
});

function turn(partial: Partial<ProjectedTurn> = {}): ProjectedTurn {
  return {
    status: "completed",
    finishReason: "end_turn",
    outcome: "ok",
    error: null,
    content: "终态正文",
    reasoning: "",
    captainContext: [],
    process: [{ kind: "content", text: "过程正文" }],
    citations: [],
    evidenceLedger: [],
    citedIds: [],
    agents: [],
    runs: [
      {
        id: "r1",
        agentId: "researcher",
        task: "查资料",
        status: "completed",
        dependsOn: [],
        outputSummary: null,
        debrief: null,
        durationMs: null,
        error: null,
        failureKind: null,
        productLanded: null,
        parentRunId: null,
        kind: "agent",
        role: "调研员",
        model: null,
        usage: null,
        cost: null,
        stance: null,
        group: null,
        round: 0,
        continuesRunId: null,
        revised: null,
        replacesRunId: null,
        actId: "act-1",
        checkpoint: null,
        receivedContext: [],
        escalations: [],
        process: [],
      },
    ],
    acts: [],
    progress: { completed: 1, total: 1 },
    interactions: [
      {
        kind: "approval",
        id: "a1",
        status: "pending",
        toolCallId: "t1",
        toolName: "bash",
        arguments: {},
      },
    ],
    cost: null,
    debate: null,
    debateRounds: [],
    debatePretrial: null,
    crossExamEnabled: false,
    debateOpening: null,
    teamSynthesisPreview: null,
    deliveryStatus: null,
    turnWarning: null,
    autoFolder: null,
    teamNotes: [],
    userInterjections: [],
    ...partial,
  };
}

describe("ChatView", () => {
  it("renders a multi-agent projected turn", () => {
    render(<ChatView content="终态正文" projected={turn()} />);
    expect(screen.getByLabelText("对话终态")).toBeTruthy();
    expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("终态正文").length).toBeGreaterThan(0);
    expect(screen.getByText("调研员")).toBeTruthy();
    expect(screen.getByText("审批")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
  });

  it("keeps projected.process when runs_payload.process is []", () => {
    render(
      <ChatView
        content="x"
        projected={turn({
          process: [{ kind: "reasoning", text: "完整思考" }],
        })}
        runsPayload={{ process: [] }}
      />,
    );
    expect(screen.getByText("完整思考")).toBeTruthy();
  });

  it("does not crash on a sparse production projected dict", () => {
    render(
      <ChatView
        content="松散投影"
        projected={{ status: "completed" }}
      />,
    );
    expect(screen.getByLabelText("对话终态")).toBeTruthy();
    expect(screen.getByText("松散投影")).toBeTruthy();
    expect(screen.queryByLabelText("来源")).toBeNull();
    expect(screen.queryByLabelText("团队")).toBeNull();
  });

  it("renders a full tool card and source card", () => {
    render(
      <ChatView
        content="综合来看"
        projected={turn({
          process: [
            { kind: "reasoning", text: "先查资料。" },
            {
              kind: "tool",
              id: "tc1",
              tool_name: "web_search",
              arguments: { query: "AgentCore 架构" },
              result: "找到来源。",
              status: "success",
            },
          ],
          citations: [
            {
              url: "https://a.example/x",
              title: "来源 A",
              snippet: "片段 A",
              site: "a.example",
              id: "#r1",
              tier: "unknown",
            },
          ],
          interactions: [
            {
              kind: "approval",
              id: "a1",
              status: "resolved",
              toolCallId: "t1",
              toolName: "bash",
              arguments: {},
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("先查资料。")).toBeTruthy();
    expect(screen.getByText("web_search")).toBeTruthy();
    expect(screen.getByLabelText("工具参数").textContent).toContain(
      "AgentCore 架构",
    );
    expect(screen.getByLabelText("工具结果").textContent).toContain("找到来源。");
    expect(screen.getByText("来源 A")).toBeTruthy();
    expect(screen.getByText("片段 A")).toBeTruthy();
    expect(screen.getByText("审批")).toBeTruthy();
    expect(screen.getByText("resolved")).toBeTruthy();
    expect(screen.queryByText(/通过|拒绝/)).toBeNull();
  });

  it("stays non-blank when projected is null (process-only row)", () => {
    render(
      <ChatView
        content="只靠正文"
        projected={null}
        runsPayload={{
          finish_reason: "end_turn",
          process: [{ kind: "tool", tool_name: "web_search", status: "success" }],
        }}
      />,
    );
    expect(screen.getByLabelText("对话终态")).toBeTruthy();
    expect(screen.getByText("只靠正文")).toBeTruthy();
    expect(screen.getByText("web_search")).toBeTruthy();
    expect(screen.getByText("finish end_turn")).toBeTruthy();
    expect(screen.queryByLabelText("团队")).toBeNull();
  });
});
