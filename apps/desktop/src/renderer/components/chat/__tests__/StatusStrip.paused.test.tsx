// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import { conversationKeys } from "@/lib/queryKeys";
import {
  type ExecutionPlan,
  ExecutionScopeContext,
  type RunFrame,
  projectExecution,
} from "@/stores/execution";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusStrip } from "../StatusStrip";

const MID = "msg-paused-strip";

const plan: ExecutionPlan = {
  id: "exec-paused",
  planType: "multi_agent",
  taskSummary: "并行调研",
  agents: [
    { id: "w1", role: "研究员", modelPreference: "strong" },
    { id: "w2", role: "撰写员", modelPreference: "fast" },
  ],
  runs: [
    { id: "r1", agentId: "w1", task: "调研", dependsOn: [] },
    { id: "r2", agentId: "w2", task: "撰写", dependsOn: ["r1"] },
  ],
};

const waveDoneFrames: RunFrame[] = [
  {
    t: 1,
    kind: "run_started",
    runId: "r1",
    agentId: "w1",
    parentRunId: null,
    runKind: "agent",
    continuesRunId: null,
  },
  {
    t: 2,
    kind: "run_completed",
    runId: "r1",
    agentId: "w1",
    outputSummary: "调研完成",
    durationMs: 100,
  },
];

function renderStrip(execution: ReturnType<typeof projectExecution>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(conversationKeys.grouped, {
    folders: [],
    conversations: [],
  });
  return render(
    <QueryClientProvider client={client}>
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
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("StatusStrip · paused", () => {
  it("plan_review 挂起显示静态「已暂停 · 等你拍板」，保留 M/N，不转圈", () => {
    const exec = projectExecution(plan, waveDoneFrames, "paused");
    expect(exec.progress).toEqual({ completed: 1, total: 2 });

    const { container } = renderStrip(exec);

    expect(screen.getByTestId("status-strip-paused")).toBeTruthy();
    expect(screen.getByText("已暂停 · 等你拍板")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("running 仍走转圈分支（回归）", () => {
    const exec = projectExecution(plan, waveDoneFrames.slice(0, 1), "running");
    const { container } = renderStrip(exec);

    expect(screen.queryByTestId("status-strip-paused")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });
});
