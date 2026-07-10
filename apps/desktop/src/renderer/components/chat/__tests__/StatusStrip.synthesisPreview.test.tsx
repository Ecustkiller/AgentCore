// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ExecutionScopeContext,
  projectExecution,
  type ExecutionPlan,
  useExecutionStore,
} from "@/stores/execution";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusStrip } from "../StatusStrip";

const MID = "msg-synth-preview";

const plan: ExecutionPlan = {
  id: "exec-1",
  planType: "multi_agent",
  taskSummary: "并行调研",
  agents: [
    { id: "w1", role: "研究员", modelPreference: "strong" },
    { id: "w2", role: "撰写员", modelPreference: "fast" },
  ],
  runs: [
    { id: "r1", agentId: "w1", task: "调研", dependsOn: [] },
    { id: "r2", agentId: "w2", task: "撰写", dependsOn: [] },
  ],
};

function renderStrip(execution: ReturnType<typeof projectExecution>) {
  return render(
    <TooltipProvider>
      <ExecutionScopeContext.Provider value={MID}>
        <StatusStrip
          execution={execution}
          expanded
          onToggle={() => {}}
          onMaximize={() => {}}
          onReplay={() => {}}
        />
      </ExecutionScopeContext.Provider>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useExecutionStore.setState({ byId: {} });
});

describe("StatusStrip · team_synthesis_preview draft", () => {
  it("renders CEO synthesis draft body from preview.text", () => {
    useExecutionStore.getState().startExecution(plan, MID);
    useExecutionStore.getState().setTeamSynthesisPreview(
      {
        execution_id: "exec-1",
        completed: 1,
        total: 2,
        headline: "合成草稿更新 · 已完成 1/2",
        text: "两边方向一致：优先方案 A，撰写员按此定稿。",
        workers: [],
        in_progress: true,
      },
      MID,
    );

    renderStrip(projectExecution(plan, [], "running"));

    expect(screen.getByTestId("team-synthesis-preview")).toBeTruthy();
    expect(screen.getByText("进展中")).toBeTruthy();
    expect(screen.getByText("合成草稿更新 · 已完成 1/2")).toBeTruthy();
    expect(screen.getByTestId("team-synthesis-draft").textContent).toContain(
      "两边方向一致：优先方案 A",
    );
  });

  it("renders worker blurbs when present (no separate draft block)", () => {
    useExecutionStore.getState().startExecution(plan, MID);
    useExecutionStore.getState().setTeamSynthesisPreview(
      {
        execution_id: "exec-1",
        completed: 1,
        total: 2,
        headline: "已完成 1/2：✅ 研究员 ⏳ 撰写员",
        text: "已完成 1/2：✅ 研究员 ⏳ 撰写员\n· 研究员：调研结论",
        workers: [
          {
            run_id: "r1",
            role: "研究员",
            status: "completed",
            summary: "调研结论",
          },
          {
            run_id: "r2",
            role: "撰写员",
            status: "pending",
            summary: "",
          },
        ],
        in_progress: true,
      },
      MID,
    );

    renderStrip(projectExecution(plan, [], "running"));

    expect(screen.getByText(/研究员：调研结论/)).toBeTruthy();
    expect(screen.queryByTestId("team-synthesis-draft")).toBeNull();
  });
});
