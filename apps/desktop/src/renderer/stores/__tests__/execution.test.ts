import { beforeEach, describe, expect, it } from "vitest";
import {
  type ExecutionPlan,
  type RunFrame,
  deriveEffective,
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
  steps: [
    { id: "step-1", agentId: "agent-1", task: "研究 React", dependsOn: [] },
    { id: "step-2", agentId: "agent-2", task: "研究 Vue", dependsOn: [] },
    {
      id: "step-3",
      agentId: "agent-1",
      task: "汇总对比",
      dependsOn: ["step-1", "step-2"],
    },
  ],
};

const store = () => useExecutionStore.getState();

beforeEach(() => {
  store().clearExecution();
});

describe("projectExecution (fold)", () => {
  it("yields an all-pending snapshot from an empty frame stream", () => {
    const exec = projectExecution(plan, [], "running");
    expect(exec.steps.every((s) => s.status === "pending")).toBe(true);
    expect(exec.agents.every((a) => a.status === "idle")).toBe(true);
    expect(exec.progress).toEqual({ completed: 0, total: 3 });
    expect(exec.taskSummary).toBe("分析对比 React 和 Vue");
  });

  it("marks step running and agent working on run_started", () => {
    const frames: RunFrame[] = [
      { t: 1, kind: "run_started", agentId: "agent-1", stepId: "step-1" },
    ];
    const exec = projectExecution(plan, frames, "running");
    expect(exec.steps.find((s) => s.id === "step-1")?.status).toBe("running");
    const agent = exec.agents.find((a) => a.id === "agent-1");
    expect(agent?.status).toBe("working");
    expect(agent?.currentStepId).toBe("step-1");
    expect(exec.steps.find((s) => s.id === "step-2")?.status).toBe("pending");
  });

  it("accumulates streamed output deltas per agent", () => {
    const frames: RunFrame[] = [
      { t: 1, kind: "run_started", agentId: "agent-1", stepId: "step-1" },
      { t: 2, kind: "run_output_delta", agentId: "agent-1", delta: "Hello " },
      { t: 3, kind: "run_output_delta", agentId: "agent-1", delta: "world" },
    ];
    const exec = projectExecution(plan, frames, "running");
    const agent = exec.agents.find((a) => a.id === "agent-1");
    expect(agent?.outputChunks.join("")).toBe("Hello world");
  });

  it("completes step with summary and duration on run_completed", () => {
    const frames: RunFrame[] = [
      { t: 1, kind: "run_started", agentId: "agent-1", stepId: "step-1" },
      {
        t: 2,
        kind: "run_completed",
        stepId: "step-1",
        agentId: "agent-1",
        outputSummary: "React 优势分析完成",
        durationMs: 1500,
      },
    ];
    const exec = projectExecution(plan, frames, "running");
    const step = exec.steps.find((s) => s.id === "step-1");
    expect(step?.status).toBe("completed");
    expect(step?.outputSummary).toBe("React 优势分析完成");
    expect(step?.durationMs).toBe(1500);
    expect(exec.agents.find((a) => a.id === "agent-1")?.status).toBe(
      "completed",
    );
  });

  it("updates progress counters from run_progress", () => {
    const frames: RunFrame[] = [
      { t: 1, kind: "run_progress", completed: 2, total: 3 },
    ];
    expect(projectExecution(plan, frames, "running").progress).toEqual({
      completed: 2,
      total: 3,
    });
  });

  it("attaches tool calls to the running step's agent", () => {
    const frames: RunFrame[] = [
      { t: 1, kind: "run_started", agentId: "agent-2", stepId: "step-2" },
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

  it("records an orchestrator continue decision without a user action", () => {
    const frames: RunFrame[] = [
      {
        t: 1,
        kind: "checkpoint_review",
        checkpointId: "cp-1",
        stepId: "step-1",
        decision: "continue",
        reason: "方向正确",
        summary: "阶段成果",
      },
    ];
    const cp = projectExecution(plan, frames, "running").steps.find(
      (s) => s.id === "step-1",
    )?.checkpoint;
    expect(cp?.decision).toBe("continue");
    expect(cp?.action).toBeNull();
  });

  it("escalate stays 待裁决 until resolved, then carries the user action", () => {
    const review: RunFrame[] = [
      {
        t: 1,
        kind: "checkpoint_review",
        checkpointId: "cp-1",
        stepId: "step-1",
        decision: "escalate",
        reason: "存在歧义",
        summary: "阶段成果",
      },
    ];

    const awaiting = projectExecution(plan, review, "paused").steps.find(
      (s) => s.id === "step-1",
    )?.checkpoint;
    expect(awaiting?.decision).toBe("escalate");
    expect(awaiting?.action).toBeNull();

    const resolved = projectExecution(
      plan,
      [
        ...review,
        {
          t: 2,
          kind: "checkpoint_resolved",
          checkpointId: "cp-1",
          action: "stop",
        },
      ],
      "running",
    ).steps.find((s) => s.id === "step-1")?.checkpoint;
    expect(resolved?.decision).toBe("escalate");
    expect(resolved?.action).toBe("stop");
  });

  it("is a pure prefix fold — replaying an earlier playhead drops later facts", () => {
    const frames: RunFrame[] = [
      { t: 1, kind: "run_started", agentId: "agent-1", stepId: "step-1" },
      { t: 2, kind: "run_output_delta", agentId: "agent-1", delta: "draft" },
      {
        t: 3,
        kind: "run_completed",
        stepId: "step-1",
        agentId: "agent-1",
        outputSummary: "done",
        durationMs: 100,
      },
    ];

    // playhead = 1 frame applied → still running, no output yet.
    const early = projectExecution(plan, frames.slice(0, 1), "running");
    expect(early.steps.find((s) => s.id === "step-1")?.status).toBe("running");
    expect(early.agents.find((a) => a.id === "agent-1")?.outputChunks).toEqual(
      [],
    );

    // playhead = all frames → completed.
    const late = projectExecution(plan, frames, "running");
    expect(late.steps.find((s) => s.id === "step-1")?.status).toBe("completed");
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
    store().recordFrame({
      t: 1,
      kind: "run_started",
      agentId: "agent-1",
      stepId: "step-1",
    });
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
    store().recordFrame({
      t: 1,
      kind: "run_started",
      agentId: "agent-1",
      stepId: "step-1",
    });
    store().clearExecution();
    expect(store().plan).toBeNull();
    expect(store().frames).toEqual([]);
    expect(store().playhead).toBeNull();
    expect(store().status).toBe("planning");
  });
});

describe("cross-view focus", () => {
  it("focusStep also resolves the owning agent via the plan", () => {
    store().startExecution(plan);
    store().focusStep("step-3");
    expect(store().focusedStepId).toBe("step-3");
    expect(store().focusedAgentId).toBe("agent-1");
  });

  it("focusAgent highlights the agent but pins no single step", () => {
    store().startExecution(plan);
    store().focusAgent("agent-2");
    expect(store().focusedAgentId).toBe("agent-2");
    expect(store().focusedStepId).toBeNull();
  });

  it("focusStep(null) and clearFocus reset both keys", () => {
    store().startExecution(plan);
    store().focusStep("step-1");
    store().focusStep(null);
    expect(store().focusedStepId).toBeNull();
    expect(store().focusedAgentId).toBeNull();

    store().focusAgent("agent-1");
    store().clearFocus();
    expect(store().focusedAgentId).toBeNull();
  });

  it("startExecution clears any prior focus", () => {
    store().startExecution(plan);
    store().focusStep("step-1");
    store().startExecution(plan);
    expect(store().focusedStepId).toBeNull();
    expect(store().focusedAgentId).toBeNull();
  });
});

describe("per-agent reasoning overrides (提案 B)", () => {
  it("deriveEffective mirrors the backend upgrade-only resolution", () => {
    // Dev-stage: both tiers think at high; fast is the no-max tier.
    expect(deriveEffective("fast", false)).toEqual({
      thinking: true,
      reasoningEffort: "high",
    });
    expect(deriveEffective("strong", false)).toEqual({
      thinking: true,
      reasoningEffort: "high",
    });
    expect(deriveEffective("strong", true)).toEqual({
      thinking: true,
      reasoningEffort: "max",
    });
    // fast ignores the deep intent (no max unlock); it stays 思考·high.
    expect(deriveEffective("fast", true)).toEqual({
      thinking: true,
      reasoningEffort: "high",
    });
  });

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
      steps: [{ id: "step-1", agentId: "agent-1", task: "t", dependsOn: [] }],
    };
    const agent = projectExecution(withMax, [], "running").agents[0];
    expect(agent).toMatchObject({ thinking: true, reasoningEffort: "max" });
  });

  it("setAgentDeep unlocks max on a strong agent", () => {
    store().startExecution(plan);
    store().setAgentDeep("agent-1", true);
    const agent = store().plan?.agents.find((a) => a.id === "agent-1");
    expect(agent).toMatchObject({ thinking: true, reasoningEffort: "max" });
  });

  it("setAgentTier to fast drops max→high; switch back lands on the default", () => {
    store().startExecution(plan);
    store().setAgentDeep("agent-1", true);
    store().setAgentTier("agent-1", "fast");
    expect(store().plan?.agents.find((a) => a.id === "agent-1")).toMatchObject({
      modelPreference: "fast",
      thinking: true,
      reasoningEffort: "high",
    });
    // Switching back to strong lands on the tier default (deep intent is reset
    // once it round-trips through fast — an accepted simplification).
    store().setAgentTier("agent-1", "strong");
    expect(store().plan?.agents.find((a) => a.id === "agent-1")).toMatchObject({
      modelPreference: "strong",
      thinking: true,
      reasoningEffort: "high",
    });
  });
});
