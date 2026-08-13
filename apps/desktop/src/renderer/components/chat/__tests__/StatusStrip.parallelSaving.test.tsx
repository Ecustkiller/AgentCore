// @vitest-environment jsdom
/**
 * 完成态状态条：「用时」旁边给出对比，让并行省下的时间看得见。
 *
 * 只派了一个人 / 并行没省到 → 什么都不说（收益只能来自真实发生的事实）。
 * 诚实边界：基准是「这些活一个接一个做要多久」，不是「单个 AI 做同一件事要多久」——
 * 后者我们没有数据。文案不得出现那种宣称，本文件末条用例就是它的绊线。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/format";
import { conversationKeys } from "@/lib/queryKeys";
import {
  type ExecutionPlan,
  ExecutionScopeContext,
  type RunFrame,
  projectExecution,
  useExecutionStore,
} from "@/stores/execution";
import {
  parallelSaving,
  parallelSavingText,
} from "@agentcore/protocol-fold-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusStrip } from "../StatusStrip";

const MID = "msg-parallel-saving";

const plan: ExecutionPlan = {
  id: "exec-parallel-saving",
  planType: "multi_agent",
  taskSummary: "调研三个方向",
  agents: [
    { id: "a1", role: "调研员" },
    { id: "a2", role: "分析师" },
    { id: "a3", role: "审校" },
  ],
  runs: [
    { id: "r1", agentId: "a1", task: "方向一", dependsOn: [] },
    { id: "r2", agentId: "a2", task: "方向二", dependsOn: [] },
    { id: "r3", agentId: "a3", task: "方向三", dependsOn: [] },
  ],
};

function started(runId: string, agentId: string, t: number): RunFrame {
  return {
    t,
    kind: "run_started",
    runId,
    agentId,
    parentRunId: null,
    runKind: "agent",
    continuesRunId: null,
  };
}

function done(
  runId: string,
  agentId: string,
  t: number,
  durationMs: number,
): RunFrame {
  return {
    t,
    kind: "run_completed",
    runId,
    agentId,
    outputSummary: "产出",
    durationMs,
  };
}

/** 三人同时开跑：各 ~40s，回合跨度 42s（t 2s → 44s）。 */
const PARALLEL: RunFrame[] = [
  started("r1", "a1", 2_000),
  started("r2", "a2", 2_000),
  started("r3", "a3", 2_000),
  done("r1", "a1", 41_000, 39_000),
  done("r2", "a2", 42_000, 40_000),
  done("r3", "a3", 44_000, 42_000),
];

/** 三人接力跑：跨度 121s == 时长之和，并行没省到任何时间。 */
const SEQUENTIAL: RunFrame[] = [
  started("r1", "a1", 0),
  done("r1", "a1", 39_000, 39_000),
  started("r2", "a2", 39_000),
  done("r2", "a2", 79_000, 40_000),
  started("r3", "a3", 79_000),
  done("r3", "a3", 121_000, 42_000),
];

function renderStrip(
  frames: RunFrame[],
  status: "completed" | "cancelled" = "completed",
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(conversationKeys.grouped, {
    folders: [],
    conversations: [],
  });
  useExecutionStore.getState().startExecution(plan, MID);
  useExecutionStore.setState((s) => ({
    byId: { ...s.byId, [MID]: { ...s.byId[MID], frames } },
  }));
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ExecutionScopeContext.Provider value={MID}>
          <StatusStrip
            execution={projectExecution(plan, frames, status)}
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

function savingText(): string | null {
  return (
    screen.queryByTestId("status-strip-parallel-saving")?.textContent ?? null
  );
}

afterEach(cleanup);
beforeEach(() => {
  useExecutionStore.setState({ byId: {} });
});

describe("StatusStrip · 完成态并行省时", () => {
  it("并行回合：用时旁边给出省下的那段（串行 2m1s − 用时 42s）", () => {
    renderStrip(PARALLEL);
    expect(screen.getByText(/用时 42s/)).toBeTruthy();
    expect(savingText()).toContain("同时开工省下 1m19s");
  });

  it("说的是共享口径那一句——不是状态条自己拼的（手机同串同数）", () => {
    // 同一组数在 apps/mobile TeamView.gain.test.tsx 断言同一句。状态条若改成自己拼
    // 文案 / 自己算数，这里立刻不等。
    renderStrip(PARALLEL);
    const gain = parallelSaving({
      elapsedMs: 42_000,
      runs: [
        { kind: "agent", durationMs: 39_000 },
        { kind: "agent", durationMs: 40_000 },
        { kind: "agent", durationMs: 42_000 },
      ],
    });
    // 这组数算不出省时，就不是「文案对不对」的问题了——先炸在这里，别拿 null 去比串。
    if (!gain) throw new Error("parallelSaving 对这组并行数据没给出省时");
    const shared = parallelSavingText(gain, formatDuration);
    expect(shared).toBe("同时开工省下 1m19s");
    expect(savingText()).toBe(` · ${shared}`);
  });

  it("接力跑（并行没省到）→ 沉默", () => {
    renderStrip(SEQUENTIAL);
    expect(savingText()).toBeNull();
  });

  it("只派了一个人 → 沉默（没有并行可言）", () => {
    const solo: ExecutionPlan = {
      ...plan,
      id: "exec-solo",
      agents: [{ id: "a1", role: "调研员" }],
      runs: [{ id: "r1", agentId: "a1", task: "全部", dependsOn: [] }],
    };
    const frames: RunFrame[] = [
      started("r1", "a1", 0),
      done("r1", "a1", 60_000, 60_000),
    ];
    useExecutionStore.getState().startExecution(solo, MID);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(conversationKeys.grouped, {
      folders: [],
      conversations: [],
    });
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ExecutionScopeContext.Provider value={MID}>
            <StatusStrip
              execution={projectExecution(solo, frames, "completed")}
              expanded
              onToggle={() => {}}
              onMaximize={() => {}}
              onReplay={() => {}}
            />
          </ExecutionScopeContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(savingText()).toBeNull();
  });

  it("硬停回合不谈「省下」（半途终止）", () => {
    renderStrip(PARALLEL, "cancelled");
    expect(screen.getByText(/已停止/)).toBeTruthy();
    expect(savingText()).toBeNull();
  });

  it("诚实边界：不宣称也不暗示「比单个 AI 快」", () => {
    renderStrip(PARALLEL);
    const strip = savingText() ?? "";
    expect(strip).not.toMatch(/单\s*个?\s*AI/);
    expect(strip).not.toMatch(/倍/);
  });
});
