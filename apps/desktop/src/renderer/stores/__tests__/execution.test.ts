import { beforeEach, describe, expect, it } from "vitest";
import {
  type ExecutionPlan,
  type RunFrame,
  elapsedMs,
  projectExecution,
  reasoningMeta,
  useExecutionStore,
} from "../execution";

const plan: ExecutionPlan = {
  id: "exec-1",
  planType: "multi_agent",
  taskSummary: "分析对比 React 和 Vue",
  agents: [
    { id: "agent-1", role: "React 研究员", modelPreference: "strong" },
    { id: "agent-2", role: "Vue 研究员", modelPreference: "fast" },
  ],
  runs: [
    { id: "run-1", agentId: "agent-1", task: "研究 React", dependsOn: [] },
    { id: "run-2", agentId: "agent-2", task: "研究 Vue", dependsOn: [] },
    {
      id: "run-3",
      agentId: "agent-1",
      task: "汇总对比",
      dependsOn: ["run-1", "run-2"],
    },
  ],
};

const store = () => useExecutionStore.getState();

/** run_started frame with the 阶段2 declaration slots defaulted (阶段1 flat). */
function started(agentId: string, runId: string, t = 1): RunFrame {
  return {
    t,
    kind: "run_started",
    agentId,
    runId,
    parentRunId: null,
    runKind: "agent",
  };
}

beforeEach(() => {
  store().clearExecution();
});

describe("projectExecution (fold)", () => {
  it("yields an all-pending snapshot from an empty frame stream", () => {
    const exec = projectExecution(plan, [], "running");
    expect(exec.runs.every((s) => s.status === "pending")).toBe(true);
    expect(exec.agents.every((a) => a.status === "idle")).toBe(true);
    expect(exec.progress).toEqual({ completed: 0, total: 3 });
    expect(exec.taskSummary).toBe("分析对比 React 和 Vue");
  });

  it("marks run running and agent working on run_started", () => {
    const frames: RunFrame[] = [started("agent-1", "run-1")];
    const exec = projectExecution(plan, frames, "running");
    expect(exec.runs.find((s) => s.id === "run-1")?.status).toBe("running");
    const agent = exec.agents.find((a) => a.id === "agent-1");
    expect(agent?.status).toBe("working");
    expect(agent?.currentRunId).toBe("run-1");
    expect(exec.runs.find((s) => s.id === "run-2")?.status).toBe("pending");
  });

  it("accumulates streamed output deltas per agent", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      { t: 2, kind: "run_output_delta", agentId: "agent-1", delta: "Hello " },
      { t: 3, kind: "run_output_delta", agentId: "agent-1", delta: "world" },
    ];
    const exec = projectExecution(plan, frames, "running");
    const agent = exec.agents.find((a) => a.id === "agent-1");
    expect(agent?.outputChunks.join("")).toBe("Hello world");
  });

  it("accumulates streamed reasoning deltas per agent (思考全文)", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      {
        t: 2,
        kind: "run_reasoning_delta",
        agentId: "agent-1",
        delta: "先拆解",
      },
      {
        t: 3,
        kind: "run_reasoning_delta",
        agentId: "agent-1",
        delta: "再对比",
      },
      // Reasoning is its own channel — it must not leak into the output text.
      { t: 4, kind: "run_output_delta", agentId: "agent-1", delta: "结论" },
    ];
    const exec = projectExecution(plan, frames, "running");
    const agent = exec.agents.find((a) => a.id === "agent-1");
    expect(agent?.reasoningChunks.join("")).toBe("先拆解再对比");
    expect(agent?.outputChunks.join("")).toBe("结论");
    // A worker that never streamed reasoning carries an empty log, not undefined.
    expect(
      exec.agents.find((a) => a.id === "agent-2")?.reasoningChunks,
    ).toEqual([]);
  });

  it("completes run with summary and duration on run_completed", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      {
        t: 2,
        kind: "run_completed",
        runId: "run-1",
        agentId: "agent-1",
        outputSummary: "React 优势分析完成",
        durationMs: 1500,
      },
    ];
    const exec = projectExecution(plan, frames, "running");
    const run = exec.runs.find((s) => s.id === "run-1");
    expect(run?.status).toBe("completed");
    expect(run?.outputSummary).toBe("React 优势分析完成");
    expect(run?.durationMs).toBe(1500);
    expect(exec.agents.find((a) => a.id === "agent-1")?.status).toBe(
      "completed",
    );
  });

  it("captures the failure reason on run_failed", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      {
        t: 2,
        kind: "run_failed",
        runId: "run-1",
        agentId: "agent-1",
        error: "工具超时：web_search",
      },
    ];
    const exec = projectExecution(plan, frames, "failed");
    const run = exec.runs.find((s) => s.id === "run-1");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("工具超时：web_search");
    expect(exec.agents.find((a) => a.id === "agent-1")?.status).toBe("error");
    // Untouched runs carry no error.
    expect(exec.runs.find((s) => s.id === "run-2")?.error).toBeNull();
  });

  it("freezes in-flight nodes as cancelled when the run is stopped", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      {
        t: 2,
        kind: "run_completed",
        runId: "run-1",
        agentId: "agent-1",
        outputSummary: "done",
        durationMs: 1,
      },
      // run-2 / agent-2 are mid-flight (no terminal frame) when the user stops.
      started("agent-2", "run-2"),
    ];
    const exec = projectExecution(plan, frames, "cancelled");
    // Already-finished work is kept.
    expect(exec.runs.find((s) => s.id === "run-1")?.status).toBe("completed");
    expect(exec.agents.find((a) => a.id === "agent-1")?.status).toBe(
      "completed",
    );
    // In-flight work is frozen as cancelled — no live spinners after a stop.
    expect(exec.runs.find((s) => s.id === "run-2")?.status).toBe("cancelled");
    expect(exec.agents.find((a) => a.id === "agent-2")?.status).toBe(
      "cancelled",
    );
    // Never-started work stays pending.
    expect(exec.runs.find((s) => s.id === "run-3")?.status).toBe("pending");
  });

  it("captures the 阶段2 declaration slots (parentRunId/kind) from run_started", () => {
    // Defaulted from the plan: a flat 阶段1 worker is a top-level `agent`.
    const base = projectExecution(plan, [], "running").runs[0];
    expect(base.parentRunId).toBeNull();
    expect(base.kind).toBe("agent");
    // run_started carries whatever the wire declared onto the node, so a later
    // graph can style nested / synthesis runs without another fold change.
    const frames: RunFrame[] = [
      {
        t: 1,
        kind: "run_started",
        agentId: "agent-1",
        runId: "run-1",
        parentRunId: "del0_root",
        runKind: "synthesis",
      },
    ];
    const run = projectExecution(plan, frames, "running").runs.find(
      (s) => s.id === "run-1",
    );
    expect(run?.parentRunId).toBe("del0_root");
    expect(run?.kind).toBe("synthesis");
  });

  it("derives progress from completed runs (run_progress is a marker)", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      {
        t: 2,
        kind: "run_completed",
        runId: "run-1",
        agentId: "agent-1",
        outputSummary: "done",
        durationMs: 1,
      },
      // Wire counters are ignored — progress folds from terminal run states so
      // it stays cumulative across multiple delegate batches.
      { t: 3, kind: "run_progress", completed: 99, total: 99 },
    ];
    expect(projectExecution(plan, frames, "running").progress).toEqual({
      completed: 1,
      total: 3,
    });
  });

  it("attaches tool calls to the running run's agent", () => {
    const frames: RunFrame[] = [
      started("agent-2", "run-2"),
      {
        t: 2,
        kind: "tool_use_start",
        toolCallId: "tc-1",
        toolName: "web_search",
        arguments: { query: "Vue" },
      },
      {
        t: 3,
        kind: "tool_use_end",
        toolCallId: "tc-1",
        result: "搜索结果…",
        status: "success",
      },
    ];
    const exec = projectExecution(plan, frames, "running");
    const agent2 = exec.agents.find((a) => a.id === "agent-2");
    expect(agent2?.toolCalls).toHaveLength(1);
    expect(agent2?.toolCalls[0].toolName).toBe("web_search");
    expect(agent2?.toolCalls[0].status).toBe("success");
    expect(agent2?.toolCalls[0].result).toBe("搜索结果…");
    expect(exec.agents.find((a) => a.id === "agent-1")?.toolCalls).toHaveLength(
      0,
    );
  });

  it("is a pure prefix fold — replaying an earlier playhead drops later facts", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      { t: 2, kind: "run_output_delta", agentId: "agent-1", delta: "draft" },
      {
        t: 3,
        kind: "run_completed",
        runId: "run-1",
        agentId: "agent-1",
        outputSummary: "done",
        durationMs: 100,
      },
    ];

    // playhead = 1 frame applied → still running, no output yet.
    const early = projectExecution(plan, frames.slice(0, 1), "running");
    expect(early.runs.find((s) => s.id === "run-1")?.status).toBe("running");
    expect(early.agents.find((a) => a.id === "agent-1")?.outputChunks).toEqual(
      [],
    );

    // playhead = all frames → completed.
    const late = projectExecution(plan, frames, "running");
    expect(late.runs.find((s) => s.id === "run-1")?.status).toBe("completed");
  });
});

describe("elapsedMs (task duration)", () => {
  it("is 0 for an empty or single-frame stream", () => {
    expect(elapsedMs([])).toBe(0);
    expect(elapsedMs([started("agent-1", "run-1", 5000)])).toBe(0);
  });

  it("is the wall-clock span between first and last frame", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1", 1000),
      { t: 2500, kind: "run_progress", completed: 1, total: 3 },
      {
        t: 155000,
        kind: "run_completed",
        runId: "run-3",
        agentId: "agent-1",
        outputSummary: "done",
        durationMs: 1,
      },
    ];
    expect(elapsedMs(frames)).toBe(154000);
  });
});

describe("execution store", () => {
  it("startExecution seeds the plan and resets the stream", () => {
    store().recordFrame({ t: 0, kind: "run_progress", completed: 1, total: 2 });
    store().startExecution(plan);
    expect(store().plan?.id).toBe("exec-1");
    expect(store().frames).toEqual([]);
    expect(store().playhead).toBeNull();
    expect(store().status).toBe("running");
  });

  it("recordFrame is a no-op without an active plan", () => {
    store().recordFrame({ t: 1, kind: "run_progress", completed: 1, total: 2 });
    expect(store().frames).toEqual([]);
  });

  it("recordFrame appends once a plan exists", () => {
    store().startExecution(plan);
    store().recordFrame(started("agent-1", "run-1"));
    expect(store().frames).toHaveLength(1);
  });

  it("setPlayhead / goLive move the scrubber", () => {
    store().startExecution(plan);
    store().setPlayhead(0);
    expect(store().playhead).toBe(0);
    store().goLive();
    expect(store().playhead).toBeNull();
  });

  it("clearExecution wipes plan, frames and playhead", () => {
    store().startExecution(plan);
    store().recordFrame(started("agent-1", "run-1"));
    store().clearExecution();
    expect(store().plan).toBeNull();
    expect(store().frames).toEqual([]);
    expect(store().playhead).toBeNull();
    expect(store().status).toBe("planning");
  });
});

describe("ingestPlan (multi-batch delegate merge)", () => {
  // A second delegate batch *in the same turn* (adaptive D1′: the CEO delegates
  // again after seeing the first batch). Shares the execution id; run ids
  // are namespaced per delegate call so they never collide with batch 1.
  const batch2: ExecutionPlan = {
    id: "exec-1",
    planType: "multi_agent",
    taskSummary: "分析对比 React 和 Vue",
    agents: [{ id: "agent-3", role: "Svelte 研究员", modelPreference: "fast" }],
    runs: [
      { id: "run-4", agentId: "agent-3", task: "研究 Svelte", dependsOn: [] },
    ],
  };

  it("starts a fresh execution for the first batch of a turn", () => {
    store().ingestPlan(plan);
    expect(store().plan?.id).toBe("exec-1");
    expect(store().plan?.runs).toHaveLength(3);
    expect(store().status).toBe("running");
  });

  it("appends a later same-turn batch instead of resetting the graph", () => {
    store().ingestPlan(plan);
    store().recordFrame(started("agent-1", "run-1"));
    store().ingestPlan(batch2);
    // New agent + run are appended; batch-1 nodes survive (the old bug wiped
    // them — only the last batch used to stay visible).
    expect(store().plan?.agents.map((a) => a.id)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
    ]);
    expect(store().plan?.runs.map((s) => s.id)).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
    ]);
    // The batch-1 frame stream is preserved across the merge.
    expect(store().frames).toHaveLength(1);
  });

  it("dedupes agents/runs already on the graph", () => {
    store().ingestPlan(plan);
    store().ingestPlan(plan);
    expect(store().plan?.agents).toHaveLength(2);
    expect(store().plan?.runs).toHaveLength(3);
  });

  it("resets the graph when a new turn's execution id differs", () => {
    store().ingestPlan(plan);
    store().recordFrame(started("agent-1", "run-1"));
    store().ingestPlan({ ...plan, id: "exec-2" });
    expect(store().plan?.id).toBe("exec-2");
    expect(store().frames).toEqual([]);
  });

  it("keeps the active focus across a same-turn merge", () => {
    store().ingestPlan(plan);
    store().focusRun("run-1");
    store().ingestPlan(batch2);
    expect(store().focusedRunId).toBe("run-1");
    expect(store().focusedAgentId).toBe("agent-1");
  });
});

describe("cross-view focus", () => {
  it("focusRun also resolves the owning agent via the plan", () => {
    store().startExecution(plan);
    store().focusRun("run-3");
    expect(store().focusedRunId).toBe("run-3");
    expect(store().focusedAgentId).toBe("agent-1");
  });

  it("focusAgent highlights the agent but pins no single run", () => {
    store().startExecution(plan);
    store().focusAgent("agent-2");
    expect(store().focusedAgentId).toBe("agent-2");
    expect(store().focusedRunId).toBeNull();
  });

  it("focusRun(null) and clearFocus reset both keys", () => {
    store().startExecution(plan);
    store().focusRun("run-1");
    store().focusRun(null);
    expect(store().focusedRunId).toBeNull();
    expect(store().focusedAgentId).toBeNull();

    store().focusAgent("agent-1");
    store().clearFocus();
    expect(store().focusedAgentId).toBeNull();
  });

  it("startExecution clears any prior focus", () => {
    store().startExecution(plan);
    store().focusRun("run-1");
    store().startExecution(plan);
    expect(store().focusedRunId).toBeNull();
    expect(store().focusedAgentId).toBeNull();
  });
});

describe("agent reasoning effort (effective knobs)", () => {
  it("reasoningMeta labels the three effective states", () => {
    expect(reasoningMeta(false, null).short).toBe("非思考");
    expect(reasoningMeta(true, "high").short).toBe("思考");
    expect(reasoningMeta(true, "max").short).toBe("深度");
  });

  it("projectExecution defaults effective knobs from the tier", () => {
    const exec = projectExecution(plan, [], "running");
    const strong = exec.agents.find((a) => a.id === "agent-1");
    const fast = exec.agents.find((a) => a.id === "agent-2");
    expect(strong).toMatchObject({ thinking: true, reasoningEffort: "high" });
    expect(fast).toMatchObject({ thinking: true, reasoningEffort: "high" });
  });

  it("projectExecution honors explicit effective knobs on the plan", () => {
    const withMax: ExecutionPlan = {
      ...plan,
      agents: [
        {
          id: "agent-1",
          role: "R",
          modelPreference: "strong",
          thinking: true,
          reasoningEffort: "max",
        },
      ],
      runs: [{ id: "run-1", agentId: "agent-1", task: "t", dependsOn: [] }],
    };
    const agent = projectExecution(withMax, [], "running").agents[0];
    expect(agent).toMatchObject({ thinking: true, reasoningEffort: "max" });
  });
});
