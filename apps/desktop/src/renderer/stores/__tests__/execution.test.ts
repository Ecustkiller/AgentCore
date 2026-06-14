import { beforeEach, describe, expect, it } from "vitest";
import {
  type ExecutionJournal,
  type ExecutionPlan,
  type RunFrame,
  elapsedMs,
  execRuntime,
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
// Every turn's execution is keyed by its assistant message id (§9.3). This suite
// drives a single message slot, so mutators take MID and reads project it.
const MID = "msg-1";
const rt = () => execRuntime(store(), MID);

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
  useExecutionStore.setState({ byId: {} });
});

describe("projectExecution (fold)", () => {
  it("yields an all-pending snapshot from an empty frame stream", () => {
    const exec = projectExecution(plan, [], "running");
    expect(exec.runs.every((s) => s.status === "pending")).toBe(true);
    expect(exec.agents.every((a) => a.status === "idle")).toBe(true);
    expect(exec.progress).toEqual({ completed: 0, total: 3 });
    expect(exec.taskSummary).toBe("分析对比 React 和 Vue");
  });

  it("threads a plan-declared synthesis kind onto the run (Phase B)", () => {
    // The CEO 汇聚点 is identifiable from the plan alone — before its run_started
    // frame folds in — so the graph can adopt it as the real sink immediately.
    const withSynth: ExecutionPlan = {
      ...plan,
      runs: [
        ...plan.runs,
        {
          id: "syn",
          agentId: "ceo",
          task: "汇总团队产出",
          dependsOn: [],
          kind: "synthesis",
        },
      ],
    };
    const exec = projectExecution(withSynth, [], "running");
    expect(exec.runs.find((s) => s.id === "syn")?.kind).toBe("synthesis");
    // Ordinary runs keep the default agent kind.
    expect(exec.runs.find((s) => s.id === "run-1")?.kind).toBe("agent");
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
    store().recordFrame(
      { t: 0, kind: "run_progress", completed: 1, total: 2 },
      MID,
    );
    store().startExecution(plan, MID);
    expect(rt().plan?.id).toBe("exec-1");
    expect(rt().frames).toEqual([]);
    expect(rt().playhead).toBeNull();
    expect(rt().status).toBe("running");
  });

  it("recordFrame is a no-op without an active plan", () => {
    store().recordFrame(
      { t: 1, kind: "run_progress", completed: 1, total: 2 },
      MID,
    );
    expect(rt().frames).toEqual([]);
  });

  it("recordFrame appends once a plan exists", () => {
    store().startExecution(plan, MID);
    store().recordFrame(started("agent-1", "run-1"), MID);
    expect(rt().frames).toHaveLength(1);
  });

  it("setPlayhead / goLive move the scrubber", () => {
    store().startExecution(plan, MID);
    store().setPlayhead(0, MID);
    expect(rt().playhead).toBe(0);
    store().goLive(MID);
    expect(rt().playhead).toBeNull();
  });

  it("clearExecution wipes plan, frames and playhead", () => {
    store().startExecution(plan, MID);
    store().recordFrame(started("agent-1", "run-1"), MID);
    store().clearExecution(MID);
    expect(rt().plan).toBeNull();
    expect(rt().frames).toEqual([]);
    expect(rt().playhead).toBeNull();
    expect(rt().status).toBe("planning");
  });

  it("keeps each message's execution isolated (§9.3)", () => {
    // Two turns stream concurrently into their own slots; neither sees the other.
    store().startExecution(plan, MID);
    store().recordFrame(started("agent-1", "run-1"), MID);
    store().startExecution({ ...plan, id: "exec-2" }, "msg-2");
    expect(execRuntime(store(), MID).plan?.id).toBe("exec-1");
    expect(execRuntime(store(), MID).frames).toHaveLength(1);
    expect(execRuntime(store(), "msg-2").plan?.id).toBe("exec-2");
    expect(execRuntime(store(), "msg-2").frames).toEqual([]);
    // Clearing one leaves the other intact.
    store().clearExecution("msg-2");
    expect(execRuntime(store(), MID).plan?.id).toBe("exec-1");
  });
});

describe("hydrateFromJournal (reload replay, §9.3)", () => {
  // A persisted turn's journal: the raw run/tool SSE events (run_plan folds into
  // the plan; the rest become frames) plus the turn's finish_reason.
  const journal: ExecutionJournal = {
    finishReason: "stop",
    events: [
      {
        type: "run_plan",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          execution_id: "exec-1",
          plan_type: "multi_agent",
          task_summary: "分析对比 React 和 Vue",
          agents: [
            { id: "agent-1", role: "React 研究员", model_preference: "strong" },
          ],
          runs: [
            {
              id: "run-1",
              agent_id: "agent-1",
              task: "研究 React",
              depends_on: [],
            },
          ],
        },
      },
      {
        type: "run_started",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: {
          agent_id: "agent-1",
          run_id: "run-1",
          parent_run_id: null,
          kind: "agent",
        },
      },
      {
        type: "run_completed",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: {
          run_id: "run-1",
          agent_id: "agent-1",
          output_summary: "done",
          duration_ms: 1000,
        },
      },
    ],
  };

  it("rebuilds the plan + frame stream from a persisted journal", () => {
    store().hydrateFromJournal(MID, journal);
    const r = rt();
    expect(r.plan?.id).toBe("exec-1");
    expect(r.plan?.runs).toHaveLength(1);
    // run_plan folds into the plan; the two run frames make the stream.
    expect(r.frames).toHaveLength(2);
    expect(r.status).toBe("completed");
    // Replays through the same fold as the live stream.
    const p = r.plan;
    if (p) {
      const exec = projectExecution(p, r.frames, r.status);
      expect(exec.runs.find((s) => s.id === "run-1")?.status).toBe("completed");
    }
  });

  it("is idempotent — never clobbers an already-built (live) slot", () => {
    store().startExecution(plan, MID);
    store().recordFrame(started("agent-1", "run-1"), MID);
    store().hydrateFromJournal(MID, journal);
    // The live slot wins; hydrate is a no-op when a plan already exists.
    expect(rt().plan?.id).toBe("exec-1");
    expect(rt().frames).toHaveLength(1);
  });

  it("draws nothing when the journal has no run_plan", () => {
    store().hydrateFromJournal(MID, { finishReason: "stop", events: [] });
    expect(rt().plan).toBeNull();
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
    store().ingestPlan(plan, MID);
    expect(rt().plan?.id).toBe("exec-1");
    expect(rt().plan?.runs).toHaveLength(3);
    expect(rt().status).toBe("running");
  });

  it("appends a later same-turn batch instead of resetting the graph", () => {
    store().ingestPlan(plan, MID);
    store().recordFrame(started("agent-1", "run-1"), MID);
    store().ingestPlan(batch2, MID);
    // New agent + run are appended; batch-1 nodes survive (the old bug wiped
    // them — only the last batch used to stay visible).
    expect(rt().plan?.agents.map((a) => a.id)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
    ]);
    expect(rt().plan?.runs.map((s) => s.id)).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
    ]);
    // The batch-1 frame stream is preserved across the merge.
    expect(rt().frames).toHaveLength(1);
  });

  it("dedupes agents/runs already on the graph", () => {
    store().ingestPlan(plan, MID);
    store().ingestPlan(plan, MID);
    expect(rt().plan?.agents).toHaveLength(2);
    expect(rt().plan?.runs).toHaveLength(3);
  });

  it("resets the graph when a new turn's execution id differs", () => {
    store().ingestPlan(plan, MID);
    store().recordFrame(started("agent-1", "run-1"), MID);
    store().ingestPlan({ ...plan, id: "exec-2" }, MID);
    expect(rt().plan?.id).toBe("exec-2");
    expect(rt().frames).toEqual([]);
  });

  it("keeps the active selection across a same-turn merge", () => {
    store().ingestPlan(plan, MID);
    store().selectRun("run-1", MID);
    store().ingestPlan(batch2, MID);
    expect(rt().selectedRunId).toBe("run-1");
  });
});

describe("cross-view selection", () => {
  it("selectRun pins the run for drill-down", () => {
    store().startExecution(plan, MID);
    store().selectRun("run-3", MID);
    expect(rt().selectedRunId).toBe("run-3");
  });

  it("selectRun(null) clears the selection", () => {
    store().startExecution(plan, MID);
    store().selectRun("run-1", MID);
    store().selectRun(null, MID);
    expect(rt().selectedRunId).toBeNull();
  });

  it("startExecution clears any prior selection", () => {
    store().startExecution(plan, MID);
    store().selectRun("run-1", MID);
    store().startExecution(plan, MID);
    expect(rt().selectedRunId).toBeNull();
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
