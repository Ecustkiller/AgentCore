// @vitest-environment jsdom
/**
 * 结辩区钻取惯例（全场统一「名字/身份行 = 打开 run 详情侧栏」）：
 * - 名字行在有 run 时是钻取按钮——不再要求产出非空（产出空时侧栏是唯一去处），
 *   侧栏标题沿用「{名字} · 结辩」；
 * - 「查看产出」文字链接已删——结辩全文本就内联（CollapsibleSpeech），文字链接只留给就地展开；
 * - 无 run（失败无 session / 旧产物）时名字行退回纯文本。
 */

import type { AgentState, Execution, RunNode } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebateClosingView } from "../../model";
import { ClosingBlocks } from "../ClosingBlocks";

vi.mock("@/components/chat/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

function closingRun(id = "mod_closing_pro"): RunNode {
  return {
    id,
    agentId: id,
    status: "completed",
    kind: "agent",
    parentRunId: null,
    revisionOf: null,
    receivedContext: [],
  } as unknown as RunNode;
}

function executionWith(agents: Partial<AgentState>[]): Execution {
  return {
    status: "completed",
    runs: [],
    agents: agents as AgentState[],
    frames: [],
    debate: null,
    debateRounds: [],
    debateDecisions: [],
    teamNotes: [],
  } as unknown as Execution;
}

function closingView(
  overrides: Partial<DebateClosingView> = {},
): DebateClosingView {
  return {
    sideKey: "pro",
    name: "支持方",
    colorVar: "var(--debate-pro)",
    run: closingRun(),
    ok: true,
    ...overrides,
  };
}

function renderClosings(closing: DebateClosingView, execution: Execution) {
  return render(
    <ClosingBlocks closings={[closing]} execution={execution} messageId="m1" />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClosingBlocks 钻取惯例", () => {
  it("名字行是钻取按钮（有 run 即可点，产出为空也一样），查看产出链接已删", () => {
    const showRunDetail = vi.fn();
    useSidePanelStore.setState({ showRunDetail });
    // agent 无产出 → text 为空：按钮仍在（这正是旧「查看产出」渲染不出的场景）。
    renderClosings(closingView(), executionWith([]));

    expect(screen.queryByRole("button", { name: "查看产出" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /支持方/ }));

    expect(showRunDetail).toHaveBeenCalledWith(
      "m1",
      "mod_closing_pro",
      "支持方 · 结辩",
    );
  });

  it("有产出时结辩全文仍内联渲染，名字行照常可钻取", () => {
    const showRunDetail = vi.fn();
    useSidePanelStore.setState({ showRunDetail });
    const execution = executionWith([
      { id: "mod_closing_pro", outputChunks: ["结辩：应有条件采用。"] },
    ]);
    renderClosings(closingView(), execution);

    expect(screen.getByTestId("markdown").textContent).toBe(
      "结辩：应有条件采用。",
    );
    fireEvent.click(screen.getByRole("button", { name: /支持方/ }));
    expect(showRunDetail).toHaveBeenCalled();
  });

  it("无 run 时名字行不是按钮，未产出警示保留", () => {
    renderClosings(closingView({ run: null, ok: false }), executionWith([]));

    expect(screen.queryByRole("button", { name: /支持方/ })).toBeNull();
    expect(screen.getByText("未产出")).toBeTruthy();
    expect(screen.getByText("未产出结辩。")).toBeTruthy();
  });
});
