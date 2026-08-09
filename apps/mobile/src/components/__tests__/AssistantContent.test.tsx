// @vitest-environment jsdom
/**
 * Render tests for the mobile assistant message renderer (前端技术与架构 §七 富渲染, AUD-012).
 *
 * AssistantContent is the shared shape consumer for both live folds and history replay. These
 * pin its composition logic — which sub-view it picks per props — with the heavy leaf children
 * (Markdown / DebateView / TeamView) stubbed, so the test targets AssistantContent's own
 * branching (process-timeline vs team/reasoning/content, debate overlay, the inline tool step,
 * citations, and the 收到的上下文 panel that hides the verbatim system prompt per 决策②), not
 * those leaves. The block comment keeps the @vitest-environment directive file-leading.
 */

import {
  AssistantContent,
  graphAppendAnchorLabel,
} from "@/components/AssistantView";
import type {
  Citation,
  ContextBlockWire,
  DebateResultPayload,
  ProcessStep,
} from "@agentcore/contract-types";
import type { ProjectedRun } from "@agentcore/protocol-conformance";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Markdown", () => ({
  Markdown: ({
    content,
    evidenceLedger,
  }: {
    content: string;
    evidenceLedger?: { id: string }[];
  }) => (
    <div
      data-testid="md"
      data-ledger={evidenceLedger?.map((e) => e.id).join(",") ?? ""}
    >
      {content}
    </div>
  ),
}));
vi.mock("@/components/DebateView", () => ({
  DebateView: () => <div data-testid="debate" />,
  LiveDebateNarrative: () => <div data-testid="live-debate" />,
}));
vi.mock("@/components/TeamView", () => ({
  TeamView: () => <div data-testid="team" />,
}));

afterEach(cleanup);

function ctxBlock(
  p: Partial<ContextBlockWire> & { channel: ContextBlockWire["channel"] },
): ContextBlockWire {
  return {
    heading: "",
    body: "",
    chars: 0,
    truncated: false,
    source_role: "",
    source_run_id: "",
    fidelity: "",
    files: [],
    ...p,
  };
}

function makeRun(p: Partial<ProjectedRun> & { id: string }): ProjectedRun {
  return {
    agentId: "a1",
    task: "task",
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
    role: null,
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
    ...p,
  };
}

describe("graphAppendAnchorLabel", () => {
  it("开辩论幕与同幕补派文案区分", () => {
    expect(graphAppendAnchorLabel(2, "debate")).toBe(
      "已开辩论幕 · 追加 2 名成员",
    );
    expect(graphAppendAnchorLabel(2, "debate", "auto")).toBe(
      "已开辩论幕 · 追加 2 名成员 · 自动开辩",
    );
    expect(graphAppendAnchorLabel(2)).toBe("已往上方协作图追加 2 名成员");
    expect(graphAppendAnchorLabel(1, "multi_agent")).toBe(
      "已往上方协作图追加 1 名成员",
    );
  });
});

describe("AssistantContent", () => {
  it("renders a pure-chat turn as Markdown, with no team/debate overlay", () => {
    render(<AssistantContent content="你好世界" />);
    expect(screen.getByTestId("md").textContent).toBe("你好世界");
    expect(screen.queryByTestId("team")).toBeNull();
    expect(screen.queryByTestId("debate")).toBeNull();
  });

  it("forwards turn evidenceLedger to Markdown (research #rN channel)", () => {
    render(
      <AssistantContent
        content="见 #r1"
        evidenceLedger={[
          {
            id: "#r1",
            url: "https://example.com",
            title: "源",
            site: "example.com",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("md").getAttribute("data-ledger")).toBe("#r1");
  });

  it("does not fall back team debate ledger into Markdown turn channel", () => {
    render(
      <AssistantContent
        content="见 #r1"
        team={{
          agents: [],
          runs: [makeRun({ id: "run1" })],
          progress: { completed: 1, total: 1 },
          evidenceLedger: [
            {
              id: "#e1",
              url: "https://debate.example",
              title: "辩",
              site: "debate.example",
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("md").getAttribute("data-ledger")).toBe("");
  });

  it("renders citations as a numbered 来源 list", () => {
    const citations: Citation[] = [
      { url: "https://a.com/post", title: "A 标题", site: "a.com" },
    ];
    render(<AssistantContent content="" citations={citations} />);
    expect(screen.getByText("来源 1")).toBeTruthy();
    const link = screen.getByRole("link", { name: /来源 1：A 标题/ });
    expect(link.getAttribute("href")).toBe("https://a.com/post");
    expect(screen.getByText("a.com")).toBeTruthy();
  });

  it("shows finishReason chip for degraded turns", () => {
    render(<AssistantContent content="降级后的短答" finishReason="degraded" />);
    expect(screen.getByTestId("finish-reason-chip").textContent).toContain(
      "降级完成",
    );
  });

  it("shows single-agent delivery shortfall hint", () => {
    render(
      <AssistantContent
        content="部分交付"
        deliveryStatus={{
          execution_id: "e1",
          state: "partial",
          summary: "缺验收项",
          delivered_files: [],
          gaps: [],
          actions: [],
        }}
      />,
    );
    expect(screen.getByTestId("delivery-shortfall-hint").textContent).toBe(
      "缺验收项",
    );
  });

  it("renders citation tier badges when tier is present", () => {
    const citations: Citation[] = [
      {
        url: "https://www.bjnews.com.cn/detail/1.html",
        title: "新京报",
        site: "bjnews.com.cn",
        tier: "media",
      },
      {
        url: "https://example.com/x",
        title: "待评源",
        site: "example.com",
        tier: "unknown",
      },
    ];
    render(<AssistantContent content="" citations={citations} />);
    expect(screen.getByText("媒体")).toBeTruthy();
    expect(screen.getByText("待评")).toBeTruthy();
  });

  it("shows 收到的上下文 but hides the verbatim system prompt (决策②)", () => {
    render(
      <AssistantContent
        content=""
        captainContext={[
          ctxBlock({ channel: "system", body: "SECRET SYSTEM PROMPT" }),
          ctxBlock({
            channel: "request",
            heading: "登录页",
            body: "做个登录页",
          }),
        ]}
      />,
    );
    // The system block is filtered out, so only 1 段 is counted and shown.
    expect(screen.getByText("收到的上下文 · 1 段")).toBeTruthy();
    expect(screen.getByText("原始请求")).toBeTruthy();
    expect(screen.getByText("做个登录页")).toBeTruthy();
    expect(screen.queryByText("SECRET SYSTEM PROMPT")).toBeNull();
  });

  it("overlays the debate product when present", () => {
    render(
      <AssistantContent content="ignored" debate={{} as DebateResultPayload} />,
    );
    expect(screen.getByTestId("debate")).toBeTruthy();
  });

  it("renders an inline tool step with its English label, detail and status", () => {
    const process: ProcessStep[] = [
      {
        kind: "tool",
        id: "t1",
        tool_name: "web_search",
        arguments: { query: "openai 新闻" },
        result: null,
        status: "success",
      },
    ];
    // isStreaming keeps process rows expanded (settled folds into「Used N tools」).
    render(<AssistantContent content="" process={process} isStreaming />);
    expect(screen.getByText("Search web")).toBeTruthy();
    expect(screen.getByText("openai 新闻")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  // Tool execution phase (network search UX)
  it("shows the live phase text for a running web_search tool", () => {
    const process: ProcessStep[] = [
      {
        kind: "tool",
        id: "t1",
        tool_name: "web_search",
        arguments: { query: "天气" },
        result: null,
        status: "running",
      },
    ];
    render(
      <AssistantContent
        content=""
        process={process}
        isStreaming
        toolPhases={new Map([["t1", "querying"]])}
      />,
    );
    // Phase text replaces the bare "Running" (a timer may be appended once ≥1s elapses).
    expect(screen.getByText(/Searching/)).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("falls back to Running for a running tool with no known phase", () => {
    const process: ProcessStep[] = [
      {
        kind: "tool",
        id: "t1",
        tool_name: "web_search",
        arguments: { query: "天气" },
        result: null,
        status: "running",
      },
    ];
    render(<AssistantContent content="" process={process} isStreaming />);
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("collapses settled Thought+tools into a process summary", () => {
    const process: ProcessStep[] = [
      { kind: "reasoning", text: "plan" },
      {
        kind: "tool",
        id: "t1",
        tool_name: "web_search",
        arguments: { query: "q" },
        result: null,
        status: "success",
      },
      { kind: "content", text: "answer" },
    ];
    render(<AssistantContent content="" process={process} />);
    expect(screen.getByText("Thought 1 step · Used 1 tool")).toBeTruthy();
    expect(screen.queryByText("Search web")).toBeNull();
    expect(screen.getByTestId("md").textContent).toBe("answer");
  });

  it("renders the team graph for a multi-agent turn", () => {
    render(
      <AssistantContent
        content=""
        process={[]}
        team={{
          agents: [],
          runs: [makeRun({ id: "r1" })],
          progress: { completed: 1, total: 1 },
        }}
      />,
    );
    expect(screen.getByTestId("team")).toBeTruthy();
  });

  it("hides TeamView when all workers are still pending (开工挂起零开跑)", () => {
    render(
      <AssistantContent
        content=""
        process={[]}
        team={{
          agents: [],
          runs: [
            makeRun({ id: "r1", status: "pending" }),
            makeRun({ id: "r2", status: "pending" }),
          ],
          progress: { completed: 0, total: 2 },
        }}
      />,
    );
    expect(screen.queryByTestId("team")).toBeNull();
  });

  it("hides TeamView when workers were skipped before start", () => {
    render(
      <AssistantContent
        content=""
        process={[]}
        team={{
          agents: [],
          runs: [
            makeRun({ id: "r1", status: "skipped" }),
            makeRun({ id: "r2", status: "skipped" }),
          ],
          progress: { completed: 0, total: 2 },
        }}
      />,
    );
    expect(screen.queryByTestId("team")).toBeNull();
  });

  it("still shows TeamView mid-wave when a completed run exists (plan_review pause)", () => {
    render(
      <AssistantContent
        content=""
        process={[]}
        team={{
          agents: [],
          runs: [
            makeRun({ id: "r1", status: "completed" }),
            makeRun({ id: "r2", status: "pending" }),
          ],
          progress: { completed: 1, total: 2 },
        }}
      />,
    );
    expect(screen.getByTestId("team")).toBeTruthy();
  });

  it("gates TeamView on process team marker when runs never started", () => {
    const process: ProcessStep[] = [{ kind: "team", execution_id: "exec-1" }];
    render(
      <AssistantContent
        content=""
        process={process}
        isStreaming
        team={{
          agents: [],
          runs: [makeRun({ id: "r1", status: "pending" })],
          progress: { completed: 0, total: 1 },
        }}
      />,
    );
    expect(screen.queryByTestId("team")).toBeNull();
  });
});
