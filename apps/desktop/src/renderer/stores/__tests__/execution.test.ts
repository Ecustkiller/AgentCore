import type { SSEEvent } from "@/types/events";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ExecutionJournal,
  type ExecutionPlan,
  type RunFrame,
  debateGroups,
  debateSides,
  elapsedMs,
  execRuntime,
  frameFromEvent,
  hasRevisions,
  isDebate,
  planFromRunPlan,
  projectExecution,
  reasoningMeta,
  revisionChains,
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
    revision: 0,
  };
}

/** A 定向唤回 续写 (乙 热修 P4) run_started frame: a revision of `parentRunId`, born
 * outside the plan, carrying its version number (original = v1, so first rev = v2). */
function revised(
  runId: string,
  parentRunId: string,
  revision: number,
  t = 1,
): RunFrame {
  return {
    t,
    kind: "run_started",
    agentId: runId,
    runId,
    parentRunId,
    runKind: "agent",
    revision,
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

  it("threads a plan-declared captain kind onto the run", () => {
    // The CEO 汇聚点 is identifiable from the plan alone — before its run_started
    // frame folds in — so the graph can adopt it as the real sink immediately.
    const withCaptain: ExecutionPlan = {
      ...plan,
      runs: [
        {
          id: "cap",
          agentId: "ceo",
          task: "",
          dependsOn: [],
          parentRunId: null,
          kind: "captain",
        },
        ...plan.runs,
      ],
    };
    const exec = projectExecution(withCaptain, [], "running");
    expect(exec.runs.find((s) => s.id === "cap")?.kind).toBe("captain");
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
    // graph can style nested / captain runs without another fold change.
    const frames: RunFrame[] = [
      {
        t: 1,
        kind: "run_started",
        agentId: "agent-1",
        runId: "run-1",
        parentRunId: "del0_root",
        runKind: "captain",
        revision: 0,
      },
    ];
    const run = projectExecution(plan, frames, "running").runs.find(
      (s) => s.id === "run-1",
    );
    expect(run?.parentRunId).toBe("del0_root");
    expect(run?.kind).toBe("captain");
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

// 结构化挂起 2a (7.2A): a `checkpoint_after` pause folds into the graph as
// plan_review frames so the gated step shows a「待放行 / 已放行 / 已停止」badge —
// driven by run.checkpoint, the same fold the timeline + reload replay run.
describe("plan_review checkpoint badge (结构化挂起 2a)", () => {
  const completed = (runId: string, agentId: string, t: number): RunFrame => ({
    t,
    kind: "run_completed",
    runId,
    agentId,
    outputSummary: "产出",
    durationMs: 1,
  });
  const required = (checkpointId: string, runIds: string[]): RunFrame => ({
    t: 5,
    kind: "plan_review_required",
    checkpointId,
    runIds,
  });
  const resolved = (
    checkpointId: string,
    decision: "continue" | "stop",
  ): RunFrame => ({
    t: 6,
    kind: "plan_review_resolved",
    checkpointId,
    decision,
  });

  it("marks the gated step pending on plan_review_required", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      completed("run-1", "agent-1", 2),
      required("c1", ["run-1"]),
    ];
    const exec = projectExecution(plan, frames, "running");
    expect(exec.runs.find((r) => r.id === "run-1")?.checkpoint).toEqual({
      status: "pending",
      decision: null,
    });
    // A node that was not gated carries no checkpoint badge.
    expect(exec.runs.find((r) => r.id === "run-2")?.checkpoint).toBeNull();
  });

  it("resolves the gated step to continue (已放行)", () => {
    const frames: RunFrame[] = [
      completed("run-1", "agent-1", 2),
      required("c1", ["run-1"]),
      resolved("c1", "continue"),
    ];
    const run = projectExecution(plan, frames, "running").runs.find(
      (r) => r.id === "run-1",
    );
    expect(run?.checkpoint).toEqual({
      status: "resolved",
      decision: "continue",
    });
  });

  it("resolves the gated step to stop (已停止)", () => {
    const frames: RunFrame[] = [
      completed("run-1", "agent-1", 2),
      required("c1", ["run-1"]),
      resolved("c1", "stop"),
    ];
    const run = projectExecution(plan, frames, "cancelled").runs.find(
      (r) => r.id === "run-1",
    );
    expect(run?.checkpoint).toEqual({ status: "resolved", decision: "stop" });
  });

  it("leaves every node's checkpoint null without plan_review frames", () => {
    const exec = projectExecution(
      plan,
      [started("agent-1", "run-1")],
      "running",
    );
    expect(exec.runs.every((r) => r.checkpoint === null)).toBe(true);
  });

  it("frameFromEvent maps plan_review events (runIds come from steps)", () => {
    const req = frameFromEvent({
      type: "plan_review_required",
      timestamp: "",
      payload: {
        checkpoint_id: "c1",
        conversation_id: "a",
        steps: [{ run_id: "run-1", role: "R", summary: "s" }],
        pending: [],
      },
    } as SSEEvent);
    expect(req).toMatchObject({
      kind: "plan_review_required",
      checkpointId: "c1",
      runIds: ["run-1"],
    });
    const res = frameFromEvent({
      type: "plan_review_resolved",
      timestamp: "",
      payload: { checkpoint_id: "c1", decision: "stop", note: "" },
    } as SSEEvent);
    expect(res).toMatchObject({
      kind: "plan_review_resolved",
      checkpointId: "c1",
      decision: "stop",
    });
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

  it("reconstructs a worker's full output + thinking from synthesized deltas (deltas 退场)", () => {
    // The backend no longer journals per-token run_output_delta / run_reasoning_delta.
    // runs_from_entries synthesizes ONE of each per worker (from its message_final),
    // reasoning before content, spliced just before run_completed — this is the exact
    // event shape a reload now receives. The UNCHANGED fold must rebuild 思考全文 + 输出
    // from it (the cross-layer 后端投影 ↔ 桌面 fold alignment that replaces the live
    // delta stream on reload).
    const synthesized: ExecutionJournal = {
      finishReason: "stop",
      events: [
        {
          type: "run_plan",
          timestamp: "2026-01-01T00:00:00.000Z",
          payload: {
            execution_id: "exec-1",
            plan_type: "multi_agent",
            task_summary: "T",
            agents: [
              { id: "agent-1", role: "研究员", model_preference: "strong" },
            ],
            runs: [
              {
                id: "run-1",
                agent_id: "agent-1",
                task: "研究",
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
          type: "run_reasoning_delta",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: { run_id: "run-1", agent_id: "agent-1", delta: "完整思考" },
        },
        {
          type: "run_output_delta",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: { run_id: "run-1", agent_id: "agent-1", delta: "完整输出" },
        },
        {
          type: "run_completed",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: {
            run_id: "run-1",
            agent_id: "agent-1",
            output_summary: "摘要",
            duration_ms: 1000,
          },
        },
      ],
    };
    store().hydrateFromJournal(MID, synthesized);
    const r = rt();
    const p = r.plan;
    expect(p).toBeTruthy();
    if (!p) return;
    const exec = projectExecution(p, r.frames, r.status);
    const agent = exec.agents.find((a) => a.id === "agent-1");
    // Full output + thinking are reconstructed from the synthesized single-block deltas.
    expect(agent?.outputChunks.join("")).toBe("完整输出");
    expect(agent?.reasoningChunks.join("")).toBe("完整思考");
    const run = exec.runs.find((s) => s.id === "run-1");
    expect(run?.status).toBe("completed");
    expect(run?.outputSummary).toBe("摘要");
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

describe("辩论/审查 display tags (前端UX设计.md §四)", () => {
  const debatePlan: ExecutionPlan = {
    id: "exec-d",
    planType: "multi_agent",
    taskSummary: "该不该上微服务",
    agents: [
      { id: "a-pro", role: "正方", modelPreference: "strong" },
      { id: "a-con", role: "反方", modelPreference: "strong" },
    ],
    runs: [
      {
        id: "r-pro",
        agentId: "a-pro",
        task: "支持",
        dependsOn: [],
        stance: "pro",
        group: "g",
      },
      {
        id: "r-con",
        agentId: "a-con",
        task: "反对",
        dependsOn: [],
        stance: "con",
        group: "g",
      },
    ],
  };

  it("projectExecution carries stance/group onto the run nodes", () => {
    const exec = projectExecution(debatePlan, [], "running");
    expect(exec.runs.find((r) => r.id === "r-pro")).toMatchObject({
      stance: "pro",
      group: "g",
    });
    expect(exec.runs.find((r) => r.id === "r-con")).toMatchObject({
      stance: "con",
      group: "g",
    });
  });

  it("ordinary runs default to null tags (守住「形状是数据不是模式」)", () => {
    // The普通并行 plan declares no stance — a debate is the only thing that tags
    // runs, so an untagged turn must project null (not a stray side).
    const exec = projectExecution(plan, [], "running");
    expect(exec.runs.every((r) => r.stance === null && r.group === null)).toBe(
      true,
    );
  });

  it("isDebate is true only when a run carries a stance", () => {
    expect(isDebate(projectExecution(debatePlan, [], "running"))).toBe(true);
    expect(isDebate(projectExecution(plan, [], "running"))).toBe(false);
  });

  it("debateSides splits the roster by side in plan order", () => {
    const sides = debateSides(projectExecution(debatePlan, [], "running"));
    expect(sides.pro.map((r) => r.id)).toEqual(["r-pro"]);
    expect(sides.con.map((r) => r.id)).toEqual(["r-con"]);
  });

  it("debateGroups buckets opposing runs by group tag (multi-dimension review)", () => {
    const multi: ExecutionPlan = {
      id: "exec-m",
      planType: "multi_agent",
      taskSummary: "多维审查",
      agents: [
        { id: "a1", role: "架构正", modelPreference: "strong" },
        { id: "a2", role: "架构反", modelPreference: "strong" },
        { id: "a3", role: "选型正", modelPreference: "strong" },
      ],
      runs: [
        {
          id: "r1",
          agentId: "a1",
          task: "t",
          dependsOn: [],
          stance: "pro",
          group: "架构",
        },
        {
          id: "r2",
          agentId: "a2",
          task: "t",
          dependsOn: [],
          stance: "con",
          group: "架构",
        },
        // An asymmetric second group (only one side) still forms its own row.
        {
          id: "r3",
          agentId: "a3",
          task: "t",
          dependsOn: [],
          stance: "pro",
          group: "选型",
        },
      ],
    };
    const groups = debateGroups(projectExecution(multi, [], "running"));
    expect(groups.map((g) => g.key)).toEqual(["架构", "选型"]);
    expect(groups[0].pro.map((r) => r.id)).toEqual(["r1"]);
    expect(groups[0].con.map((r) => r.id)).toEqual(["r2"]);
    expect(groups[1].pro.map((r) => r.id)).toEqual(["r3"]);
    expect(groups[1].con).toEqual([]);
  });

  it("debateGroups collapses untagged stances into one default group", () => {
    const noGroup: ExecutionPlan = {
      ...debatePlan,
      runs: debatePlan.runs.map(({ group: _g, ...r }) => r),
    };
    const groups = debateGroups(projectExecution(noGroup, [], "running"));
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("");
    expect(groups[0].pro).toHaveLength(1);
    expect(groups[0].con).toHaveLength(1);
  });

  it("planFromRunPlan maps the wire stance/group through to the plan", () => {
    const wirePlan = planFromRunPlan({
      execution_id: "exec-d",
      plan_type: "multi_agent",
      task_summary: "t",
      agents: [
        {
          id: "a-pro",
          role: "正方",
          model_preference: "strong",
          thinking: true,
          reasoning_effort: "high",
        },
      ],
      runs: [
        {
          id: "r-pro",
          agent_id: "a-pro",
          task: "支持",
          depends_on: [],
          stance: "pro",
          group: "g",
        },
      ],
    });
    expect(wirePlan.runs[0]).toMatchObject({ stance: "pro", group: "g" });
  });

  it("projectExecution defaults round to 0 and carries an explicit round", () => {
    // round is display-only (真·多轮辩论): absent ⇒ 0 (single-round), present ⇒ the
    // 1-based turn, projected onto the node the immutable way stance/group are.
    const exec = projectExecution(debatePlan, [], "running");
    expect(exec.runs.every((r) => r.round === 0)).toBe(true);

    const roundedPlan: ExecutionPlan = {
      ...debatePlan,
      runs: debatePlan.runs.map((r, i) => ({ ...r, round: i + 1 })),
    };
    const rounded = projectExecution(roundedPlan, [], "running");
    expect(rounded.runs.find((r) => r.id === "r-pro")?.round).toBe(1);
    expect(rounded.runs.find((r) => r.id === "r-con")?.round).toBe(2);
  });

  it("debateGroups buckets a group's runs by round (真·多轮辩论, 升序)", () => {
    // Two rounds of pro/con in one group: cross-round depends_on wires the exchange,
    // round tags let the card lay it out 逐轮. Buckets come back round-ascending,
    // while the flat pro/con rosters stay whole for the single-round layout.
    const debate3: ExecutionPlan = {
      id: "exec-3",
      planType: "multi_agent",
      taskSummary: "多轮辩论",
      agents: [
        { id: "a-pro", role: "正方", modelPreference: "strong" },
        { id: "a-con", role: "反方", modelPreference: "strong" },
      ],
      runs: [
        {
          id: "p1",
          agentId: "a-pro",
          task: "t",
          dependsOn: [],
          stance: "pro",
          group: "g",
          round: 1,
        },
        {
          id: "c1",
          agentId: "a-con",
          task: "t",
          dependsOn: [],
          stance: "con",
          group: "g",
          round: 1,
        },
        {
          id: "p2",
          agentId: "a-pro",
          task: "t",
          dependsOn: ["c1"],
          stance: "pro",
          group: "g",
          round: 2,
        },
        {
          id: "c2",
          agentId: "a-con",
          task: "t",
          dependsOn: ["p1"],
          stance: "con",
          group: "g",
          round: 2,
        },
      ],
    };
    const groups = debateGroups(projectExecution(debate3, [], "running"));
    expect(groups).toHaveLength(1);
    expect(groups[0].rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(groups[0].rounds[0].pro.map((r) => r.id)).toEqual(["p1"]);
    expect(groups[0].rounds[0].con.map((r) => r.id)).toEqual(["c1"]);
    expect(groups[0].rounds[1].pro.map((r) => r.id)).toEqual(["p2"]);
    expect(groups[0].rounds[1].con.map((r) => r.id)).toEqual(["c2"]);
    expect(groups[0].pro.map((r) => r.id)).toEqual(["p1", "p2"]);
  });

  it("debateGroups yields one round-0 bucket for a single-round debate", () => {
    // No round tags ⇒ a lone round-0 bucket, so the card keeps the flat 正/反 grid.
    const groups = debateGroups(projectExecution(debatePlan, [], "running"));
    expect(groups[0].rounds.map((r) => r.round)).toEqual([0]);
    expect(groups[0].rounds.some((r) => r.round > 0)).toBe(false);
  });

  it("planFromRunPlan maps the wire round through to the plan", () => {
    const wirePlan = planFromRunPlan({
      execution_id: "exec-r",
      plan_type: "multi_agent",
      task_summary: "t",
      agents: [
        {
          id: "a-pro",
          role: "正方",
          model_preference: "strong",
          thinking: true,
          reasoning_effort: "high",
        },
      ],
      runs: [
        {
          id: "r-pro",
          agent_id: "a-pro",
          task: "支持",
          depends_on: [],
          stance: "pro",
          group: "g",
          round: 2,
        },
      ],
    });
    expect(wirePlan.runs[0]).toMatchObject({
      stance: "pro",
      group: "g",
      round: 2,
    });
  });
});

describe("定向唤回 版本链 (乙 热修 P4)", () => {
  function completed(runId: string, agentId: string, t: number): RunFrame {
    return {
      t,
      kind: "run_completed",
      runId,
      agentId,
      outputSummary: "done",
      durationMs: 1,
    };
  }

  it("ordinary runs default to no revision (revisionOf null, revision 0)", () => {
    // 续写 is the only thing that marks a run as a revision; a plain plan must
    // project null/0 (not a stray version).
    const exec = projectExecution(plan, [], "running");
    expect(
      exec.runs.every((r) => r.revisionOf === null && r.revision === 0),
    ).toBe(true);
    expect(hasRevisions(exec)).toBe(false);
    expect(revisionChains(exec)).toEqual([]);
  });

  it("synthesizes a 修订 node + agent from a revision run_started (not in plan)", () => {
    // A revision is born from its frame, NOT the plan — so without synthesis it
    // would be dropped. It must materialize, hang off the original, and fold its
    // own output through the inherited (original) display identity.
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      completed("run-1", "agent-1", 2),
      revised("run-1_rev1", "run-1", 2, 3),
      { t: 4, kind: "run_output_delta", agentId: "run-1_rev1", delta: "改后" },
      { t: 5, kind: "run_output_delta", agentId: "run-1_rev1", delta: "内容" },
      completed("run-1_rev1", "run-1_rev1", 6),
    ];
    const exec = projectExecution(plan, frames, "completed");

    const rev = exec.runs.find((r) => r.id === "run-1_rev1");
    expect(rev).toBeTruthy();
    expect(rev?.revisionOf).toBe("run-1");
    expect(rev?.revision).toBe(2);
    expect(rev?.parentRunId).toBe("run-1");
    expect(rev?.status).toBe("completed");
    // inherits the original worker's display role (not the raw run id)
    const revAgent = exec.agents.find((a) => a.id === "run-1_rev1");
    expect(revAgent?.role).toBe("React 研究员");
    expect(revAgent?.modelPreference).toBe("strong");
    expect(revAgent?.outputChunks.join("")).toBe("改后内容");
    // the original keeps its own output (the version chain preserves每版)
    expect(exec.runs.find((r) => r.id === "run-1")?.status).toBe("completed");
  });

  it("ignores a revision whose original is not on the graph (no mis-draw)", () => {
    const frames: RunFrame[] = [revised("ghost_rev1", "ghost", 2)];
    const exec = projectExecution(plan, frames, "running");
    expect(exec.runs.find((r) => r.id === "ghost_rev1")).toBeUndefined();
    expect(exec.runs).toHaveLength(3); // only the plan's own runs
  });

  it("revisionChains builds v1 原始 + 续写 in ascending version order", () => {
    // rev2 (v3) arrives BEFORE rev1 (v2) to prove the chain sorts by version, not
    // arrival — every version is kept (P-2 保留版本链), original first.
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      completed("run-1", "agent-1", 2),
      revised("run-1_rev2", "run-1", 3, 3),
      completed("run-1_rev2", "run-1_rev2", 4),
      revised("run-1_rev1", "run-1", 2, 5),
      completed("run-1_rev1", "run-1_rev1", 6),
    ];
    const exec = projectExecution(plan, frames, "completed");

    expect(hasRevisions(exec)).toBe(true);
    const chains = revisionChains(exec);
    expect(chains).toHaveLength(1);
    expect(chains[0].originalId).toBe("run-1");
    expect(chains[0].versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(chains[0].versions.map((v) => v.run.id)).toEqual([
      "run-1",
      "run-1_rev1",
      "run-1_rev2",
    ]);
  });

  it("revisionChains yields one chain per revised worker, in graph order", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      completed("run-1", "agent-1", 2),
      started("agent-2", "run-2"),
      completed("run-2", "agent-2", 3),
      // revise run-2 first, then run-1 — chains still follow graph (run) order.
      revised("run-2_rev1", "run-2", 2, 4),
      completed("run-2_rev1", "run-2_rev1", 5),
      revised("run-1_rev1", "run-1", 2, 6),
      completed("run-1_rev1", "run-1_rev1", 7),
    ];
    const exec = projectExecution(plan, frames, "completed");
    const chains = revisionChains(exec);
    expect(chains.map((c) => c.originalId)).toEqual(["run-1", "run-2"]);
  });

  it("is a pure prefix fold — a revision appears only past its run_started", () => {
    const frames: RunFrame[] = [
      started("agent-1", "run-1"),
      completed("run-1", "agent-1", 2),
      revised("run-1_rev1", "run-1", 2, 3),
      completed("run-1_rev1", "run-1_rev1", 4),
    ];
    // playhead before the revision frame → no revision node yet.
    const before = projectExecution(plan, frames.slice(0, 2), "running");
    expect(hasRevisions(before)).toBe(false);
    // full stream → the revision is present.
    const after = projectExecution(plan, frames, "completed");
    expect(hasRevisions(after)).toBe(true);
  });
});
