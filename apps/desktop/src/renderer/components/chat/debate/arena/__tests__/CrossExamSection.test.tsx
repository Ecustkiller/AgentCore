// @vitest-environment jsdom
/**
 * 质询块「展开全文」交互（对齐立论区 ArgumentSpeech.showAll）：
 * - 头行链接就地展开该方作答 run 的完整产出（展开后头行+底部各一枚「收起全文」），
 *   Q 行列表与全文互斥切换；全文不再套 CollapsibleSpeech；
 * - 名字行对齐 SpeakerBlock 惯例 → 打开 run 详情侧栏（showRunDetail）；
 * - 空态（exchanges 为空的旧载荷）同样支持就地展开——它是该场景唯一的内容入口；
 *   无 run 输出时不显示链接。
 */

import type { AgentState, Execution, RunNode } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebateCrossExamView } from "../../model";
import { CrossExamSection } from "../CrossExamSection";

vi.mock("@/components/chat/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

const FULL_OUTPUT = "作答全文：口径未含尾部风险，熔断成本由平台承担。";

function answerRun(id = "mod_r1_cx_pro"): RunNode {
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

function cxView(
  overrides: Partial<DebateCrossExamView> = {},
): DebateCrossExamView {
  return {
    targetKey: "pro",
    targetName: "支持方",
    targetColorVar: "var(--debate-pro)",
    exchanges: [
      { question: "收益口径是否含尾部风险？", answer: "已含。", ok: true },
    ],
    answerRun: answerRun(),
    ...overrides,
  };
}

function renderSection(cx: DebateCrossExamView, execution: Execution) {
  return render(
    <CrossExamSection
      exchanges={[cx]}
      execution={execution}
      messageId="m1"
      sceneKey="m1:cx:r1"
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CrossExamSection 展开全文", () => {
  it("头行链接就地展开完整产出，与 Q 行列表互斥切换", () => {
    const execution = executionWith([
      { id: "mod_r1_cx_pro", outputChunks: [FULL_OUTPUT] },
    ]);
    renderSection(cxView(), execution);

    // 收起态：Q 行可见、run 全文不可见（QA 行答案体的 Markdown 始终在 DOM，只按内容区分）。
    expect(screen.getByText(/收益口径是否含尾部风险/)).toBeTruthy();
    expect(screen.queryByText(FULL_OUTPUT)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));

    expect(screen.getByText(FULL_OUTPUT)).toBeTruthy();
    expect(screen.queryByText(/收益口径是否含尾部风险/)).toBeNull();
    // 头行 + 底部各一枚「收起全文」（对齐立论区）；无 CollapsibleSpeech 夹层。
    expect(screen.getAllByRole("button", { name: "收起全文" })).toHaveLength(
      2,
    );
    expect(screen.queryByRole("button", { name: "收起" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "收起全文" })[0]);

    expect(screen.queryByText(FULL_OUTPUT)).toBeNull();
    expect(screen.getByText(/收益口径是否含尾部风险/)).toBeTruthy();
  });

  it("空态（exchanges 为空）保留一行提示，展开全文是唯一内容入口", () => {
    const execution = executionWith([
      { id: "mod_r1_cx_pro", outputChunks: [FULL_OUTPUT] },
    ]);
    renderSection(cxView({ exchanges: [] }), execution);

    expect(screen.getByText("暂无质询问答")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(screen.getByTestId("markdown").textContent).toBe(FULL_OUTPUT);
    expect(screen.getAllByRole("button", { name: "收起全文" })).toHaveLength(
      2,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "收起全文" })[1]);
    expect(screen.queryByTestId("markdown")).toBeNull();
  });

  it("无 run 输出时不显示展开链接", () => {
    // run 在但 agent 无产出（作答失败）。
    renderSection(cxView({ exchanges: [] }), executionWith([]));
    expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();

    cleanup();

    // 连 run 都没有（旧产物）：无链接、名字行也不是按钮。
    renderSection(
      cxView({ exchanges: [], answerRun: null }),
      executionWith([]),
    );
    expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
    expect(screen.queryByRole("button", { name: /支持方/ })).toBeNull();
  });

  it("点名字行打开该方作答 run 的详情侧栏（对齐 SpeakerBlock）", () => {
    const showRunDetail = vi.fn();
    useSidePanelStore.setState({ showRunDetail });
    const execution = executionWith([
      { id: "mod_r1_cx_pro", outputChunks: [FULL_OUTPUT] },
    ]);
    renderSection(cxView(), execution);

    fireEvent.click(screen.getByRole("button", { name: /支持方/ }));

    expect(showRunDetail).toHaveBeenCalledWith(
      "m1",
      "mod_r1_cx_pro",
      "支持方 · 质询作答",
    );
  });
});
