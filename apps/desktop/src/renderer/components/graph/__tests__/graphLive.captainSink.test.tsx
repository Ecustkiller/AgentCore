// @vitest-environment jsdom
import { useCaptainEndpointLive } from "@/components/graph/graphLive";
import {
  type ExecutionPlan,
  ExecutionScopeContext,
  type RunFrame,
  useExecutionStore,
} from "@/stores/execution";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MID = "msg-captain-sink";
const CAP = "r-cap";

const plan: ExecutionPlan = {
  id: "exec-sink",
  planType: "multi_agent",
  taskSummary: "并行调研",
  agents: [
    { id: "ceo", role: "CEO" },
    { id: "w1", role: "研究员" },
  ],
  runs: [
    { id: CAP, agentId: "ceo", task: "", dependsOn: [] },
    { id: "r1", agentId: "w1", task: "调研", dependsOn: [] },
  ],
};

const startedBoth: RunFrame[] = [
  {
    t: 1,
    kind: "run_started",
    runId: CAP,
    agentId: "ceo",
    parentRunId: null,
    runKind: "captain",
    continuesRunId: null,
  },
  {
    t: 2,
    kind: "run_started",
    runId: "r1",
    agentId: "w1",
    parentRunId: null,
    runKind: "agent",
    continuesRunId: null,
  },
];

const workerDone: RunFrame = {
  t: 3,
  kind: "run_completed",
  runId: "r1",
  agentId: "w1",
  outputSummary: "完成调研",
  durationMs: 1000,
};

function seed(frames: RunFrame[]): void {
  useExecutionStore.getState().startExecution(plan, MID);
  for (const frame of frames) {
    useExecutionStore.getState().recordFrame(frame, MID);
  }
}

function renderSink() {
  return renderHook(() => useCaptainEndpointLive(CAP), {
    wrapper: ({ children }) => (
      <ExecutionScopeContext.Provider value={MID}>
        {children}
      </ExecutionScopeContext.Provider>
    ),
  });
}

beforeEach(() => {
  useExecutionStore.setState({ byId: {} });
});

afterEach(() => {
  cleanup();
});

describe("useCaptainEndpointLive · CEO 汇总节点外壳", () => {
  it("收尾完成后不再转圈", () => {
    seed([...startedBoth, workerDone]);
    // 队员终态帧落地即由 recordFrame → maybeCompleteIfWorkersSettled 收口。
    expect(useExecutionStore.getState().byId[MID]?.status).toBe("completed");

    const { result } = renderSink();

    // 回归点：等待句曾由 workerProgress(execution) 恒真喂出来，把外壳钉死在
    // "running" —— 队员全绿、回合已收口，汇总节点却永远「正在收尾…」。
    expect(result.current.status).toBe("completed");
    expect(result.current.statusCaption).toBeUndefined();
  });

  it("待汇总（无协调等待）守 pending，不假转圈", () => {
    seed(startedBoth);

    const { result } = renderSink();

    expect(result.current.status).toBe("pending");
    expect(result.current.statusCaption).toBeUndefined();
  });

  it("协调等待才上 running 外壳并挂等待句", () => {
    seed(startedBoth);
    useExecutionStore.getState().setCoordinationWait(
      {
        execution_id: "exec-sink",
        waiting: true,
        completed: 0,
        total: 1,
      },
      MID,
    );

    const { result } = renderSink();

    expect(result.current.status).toBe("running");
    expect(result.current.statusCaption).toBe("等待「研究员」(0/1)");
  });
});
