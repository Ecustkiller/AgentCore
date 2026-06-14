import type { CostBreakdown, RunKind, UsageBreakdown } from "@/types/events";
import { useMemo } from "react";
import { create } from "zustand";

export type RunStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ExecutionStatus =
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Orchestrator per-agent model preference (the two backend tiers). Single-agent
 * chat uses a standalone `chat` profile and never carries a tier, so this only
 * ever appears on multi-agent graph nodes.
 */
export type ModelTier = "fast" | "strong";

/** Display metadata for each tier — the single source the graph + detail share. */
export const MODEL_TIER_META: Record<
  ModelTier,
  { label: string; short: string; description: string }
> = {
  fast: {
    label: "快速档",
    short: "快",
    description:
      "思考·high、回合预算小，面向较简单/范围明确的子任务（取数·格式化·单点查询·简单改写），是更快更省的一档。",
  },
  strong: {
    label: "强力档",
    short: "强",
    description:
      "思考·high、回合预算大，面向需要判断或对质量有要求的子任务；可经「深度」升 max。",
  },
};

/**
 * Effective reasoning effort (提案 B). `null` = non-thinking; no worker tier is
 * non-thinking anymore (dev-stage: both tiers think at `high`), so this only
 * appears for background mechanical roles. Mirrors the backend `reasoning_effort`
 * after `apply_overrides`.
 */
export type ReasoningEffort = "high" | "max" | null;

/** Display label for the effective reasoning state — the single source the
 * graph badge and detail panel share. */
export function reasoningMeta(
  thinking: boolean,
  effort: ReasoningEffort,
): { short: string; label: string; description: string } {
  if (!thinking)
    return {
      short: "非思考",
      label: "非思考",
      description: "不走思考链，最快最省，面向简单/机械子任务。",
    };
  if (effort === "max")
    return {
      short: "深度",
      label: "深度思考 (max)",
      description: "最强推理强度，面向极复杂、需要最高质量的子任务。",
    };
  return {
    short: "思考",
    label: "思考 (high)",
    description: "标准思考强度，面向需要判断或对质量有要求的子任务。",
  };
}

export interface ToolCallState {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string | null;
  status: "running" | "success" | "error";
}

export interface AgentState {
  id: string;
  role: string;
  modelPreference: ModelTier;
  /** Effective reasoning state (tier default + per-agent override, 提案 B). */
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  status: "idle" | "working" | "completed" | "error" | "cancelled";
  currentRunId: string | null;
  outputChunks: string[];
  /** Streamed thinking chunks (run_reasoning_delta), joined for 思考全文. Empty
   * for non-thinking workers or older journals that never carried reasoning. */
  reasoningChunks: string[];
  toolCalls: ToolCallState[];
}

export interface RunNode {
  id: string;
  agentId: string;
  task: string;
  status: RunStatus;
  dependsOn: string[];
  outputSummary: string | null;
  durationMs: number | null;
  /** Failure reason from `run_failed`; null unless this run failed. */
  error: string | null;
  /** Delegating run id (`run_started` slot). 阶段1 always null (flat workers
   * under the CEO); set for 阶段2 nested delegation. */
  parentRunId: string | null;
  /** Node kind from `run_started`. 阶段1 always `agent`; `synthesis` / `arena`
   * are 阶段2 slots, carried here so the graph can later style them. */
  kind: RunKind;
  /** Cost-ledger role of the run (member/captain/…) from `run_completed`; null
   * until the run completes. 阶段1 scheduled runs are always "member". */
  role: string | null;
  /** Model id the run billed on (e.g. deepseek-v4-flash); null until completed.
   * Workers may differ in tier, so this is per-run (payroll power detail). */
  model: string | null;
  /** This run's token usage (payroll power detail); null until completed. */
  usage: UsageBreakdown | null;
  /** This run's priced cost in nano-USD (lights up one payroll row, §7.3B);
   * null until completed / unmetered. All-zero `total` renders as「—」(§7.5). */
  cost: CostBreakdown | null;
}

export interface Execution {
  id: string;
  planType: "single_agent" | "multi_agent";
  taskSummary: string;
  status: ExecutionStatus;
  agents: AgentState[];
  runs: RunNode[];
  progress: { completed: number; total: number };
}

/**
 * Immutable skeleton declared once when the DAG is planned (`run_plan`).
 * Frames mutate a *projection* of this skeleton — never the skeleton itself.
 */
export interface ExecutionPlan {
  id: string;
  planType: "single_agent" | "multi_agent";
  taskSummary: string;
  agents: {
    id: string;
    role: string;
    modelPreference: ModelTier;
    thinking?: boolean;
    reasoningEffort?: ReasoningEffort;
  }[];
  runs: { id: string; agentId: string; task: string; dependsOn: string[] }[];
}

/**
 * One recorded run-level fact. The frame stream is append-only and is the
 * single source of truth for the collaboration graph — mirroring the backend
 * Turn Journal. "Live" is simply playhead = end-of-stream; "replay" is any
 * earlier playhead. Both render through the same {@link projectExecution} fold,
 * so there is no second code path to keep in sync.
 */
export type RunFrame =
  | {
      t: number;
      kind: "run_started";
      agentId: string;
      runId: string;
      // `runKind` (not `kind`) because `kind` is this union's discriminant; it
      // carries the wire `kind` (agent/synthesis/arena). 阶段2 declaration slots.
      parentRunId: string | null;
      runKind: RunKind;
    }
  | { t: number; kind: "run_output_delta"; agentId: string; delta: string }
  | { t: number; kind: "run_reasoning_delta"; agentId: string; delta: string }
  | {
      t: number;
      kind: "run_completed";
      runId: string;
      agentId: string;
      outputSummary: string;
      durationMs: number;
      // Cost-ledger fields from `run_completed` (§7.3B payroll). Optional so a
      // frame without them (older streams / a journal replay that lacks cost)
      // still projects — the run simply carries no priced cost.
      role?: string;
      model?: string;
      usage?: UsageBreakdown;
      cost?: CostBreakdown;
    }
  | {
      t: number;
      kind: "run_failed";
      runId: string;
      agentId: string;
      error: string;
    }
  | { t: number; kind: "run_progress"; completed: number; total: number }
  | {
      t: number;
      kind: "tool_use_start";
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      t: number;
      kind: "tool_use_end";
      toolCallId: string;
      result: string;
      status: "success" | "error";
    };

/**
 * Fold a prefix of the frame stream into a full {@link Execution} snapshot.
 *
 * Pure and deterministic: feeding `frames.slice(0, n)` yields the exact state
 * the graph had after the n-th fact, which is what powers timeline replay.
 */
export function projectExecution(
  plan: ExecutionPlan,
  frames: RunFrame[],
  status: ExecutionStatus,
): Execution {
  const agents: AgentState[] = plan.agents.map((a) => ({
    id: a.id,
    role: a.role,
    modelPreference: a.modelPreference,
    thinking: a.thinking ?? true,
    reasoningEffort: a.reasoningEffort ?? "high",
    status: "idle",
    currentRunId: null,
    outputChunks: [],
    reasoningChunks: [],
    toolCalls: [],
  }));
  const runs: RunNode[] = plan.runs.map((s) => ({
    id: s.id,
    agentId: s.agentId,
    task: s.task,
    status: "pending",
    dependsOn: s.dependsOn,
    outputSummary: null,
    durationMs: null,
    error: null,
    parentRunId: null,
    kind: "agent",
    role: null,
    model: null,
    usage: null,
    cost: null,
  }));

  const agentById = (id: string) => agents.find((a) => a.id === id);
  const runById = (id: string) => runs.find((s) => s.id === id);

  for (const f of frames) {
    switch (f.kind) {
      case "run_started": {
        const run = runById(f.runId);
        if (run) {
          run.status = "running";
          // Capture the 阶段2 declaration slots onto the node so a later graph
          // can read them from the projected run (inert in 阶段1).
          run.parentRunId = f.parentRunId;
          run.kind = f.runKind;
        }
        const agent = agentById(f.agentId);
        if (agent) {
          agent.status = "working";
          agent.currentRunId = f.runId;
        }
        break;
      }
      case "run_output_delta": {
        const agent = agentById(f.agentId);
        if (agent) agent.outputChunks.push(f.delta);
        break;
      }
      case "run_reasoning_delta": {
        const agent = agentById(f.agentId);
        if (agent) agent.reasoningChunks.push(f.delta);
        break;
      }
      case "run_completed": {
        const run = runById(f.runId);
        if (run) {
          run.status = "completed";
          run.outputSummary = f.outputSummary;
          run.durationMs = f.durationMs;
          // Light up this run's payroll row (§7.3B); absent on cost-less frames.
          run.role = f.role ?? null;
          run.model = f.model ?? null;
          run.usage = f.usage ?? null;
          run.cost = f.cost ?? null;
        }
        const agent = agentById(f.agentId);
        if (agent) {
          agent.status = "completed";
          agent.currentRunId = null;
        }
        break;
      }
      case "run_failed": {
        const run = runById(f.runId);
        if (run) {
          run.status = "failed";
          run.error = f.error;
        }
        const agent = agentById(f.agentId);
        if (agent) agent.status = "error";
        break;
      }
      case "run_progress": {
        // Progress is derived from run states below so it stays correct and
        // cumulative across multiple delegate batches (the per-batch wire
        // counters would reset). The frame is kept only as a timeline marker.
        break;
      }
      case "tool_use_start": {
        // Tool events are not run-scoped on the wire; attach to whichever run
        // is running at this point in the fold (matches prior live behaviour).
        const running = runs.find((s) => s.status === "running");
        const agent = running ? agentById(running.agentId) : undefined;
        if (agent) {
          agent.toolCalls.push({
            id: f.toolCallId,
            toolName: f.toolName,
            arguments: f.arguments,
            result: null,
            status: "running",
          });
        }
        break;
      }
      case "tool_use_end": {
        for (const agent of agents) {
          const tc = agent.toolCalls.find((t) => t.id === f.toolCallId);
          if (tc) {
            tc.result = f.result;
            tc.status = f.status;
            break;
          }
        }
        break;
      }
    }
  }

  // A stopped turn never receives terminal run frames for its in-flight nodes;
  // freeze them as cancelled so the card leaves its live state (no spinners /
  // progress bar) instead of looking like it is still running.
  if (status === "cancelled") {
    for (const s of runs) if (s.status === "running") s.status = "cancelled";
    for (const a of agents) if (a.status === "working") a.status = "cancelled";
  }

  return {
    id: plan.id,
    planType: plan.planType,
    taskSummary: plan.taskSummary,
    status,
    agents,
    runs,
    // Derived (not from run_progress): count terminal-completed nodes over the
    // cumulative run set, so multi-batch delegate progress is always correct.
    progress: {
      completed: runs.filter((s) => s.status === "completed").length,
      total: runs.length,
    },
  };
}

/** Human-readable label for a frame, used by the timeline scrubber. */
export function describeFrame(frame: RunFrame, plan: ExecutionPlan): string {
  const role = (agentId: string) =>
    plan.agents.find((a) => a.id === agentId)?.role ?? agentId;
  const task = (runId: string) =>
    plan.runs.find((s) => s.id === runId)?.task ?? runId;

  switch (frame.kind) {
    case "run_started":
      return `${role(frame.agentId)} 开始 · ${task(frame.runId)}`;
    case "run_output_delta":
      return `${role(frame.agentId)} 输出中…`;
    case "run_reasoning_delta":
      return `${role(frame.agentId)} 思考中…`;
    case "run_completed":
      return `${role(frame.agentId)} 完成`;
    case "run_failed":
      return `${role(frame.agentId)} 失败`;
    case "run_progress":
      return `进度 ${frame.completed}/${frame.total}`;
    case "tool_use_start":
      return `调用工具 ${frame.toolName}`;
    case "tool_use_end":
      return `工具${frame.status === "success" ? "完成" : "失败"}`;
  }
}

/**
 * Wall-clock span covered by a frame stream, in ms (0 if fewer than 2 frames).
 *
 * Used for the completed task card's "用时" summary. Wall-clock (last − first
 * frame timestamp) is correct regardless of parallelism, unlike summing
 * per-run durations which would overcount concurrent agents.
 */
export function elapsedMs(frames: RunFrame[]): number {
  if (frames.length < 2) return 0;
  return Math.max(0, frames[frames.length - 1].t - frames[0].t);
}

interface ExecutionState {
  plan: ExecutionPlan | null;
  frames: RunFrame[];
  /** Number of frames to project. `null` = follow the live tail. */
  playhead: number | null;
  status: ExecutionStatus;

  /**
   * Cross-view selection shared by the graph and the in-chat task card. A
   * run focus pins one node (and its agent); an agent focus highlights every
   * node that agent owns. Bridged through {@link ExecutionPlan} so either view
   * can drive the other even though they are never on screen at once.
   */
  focusedRunId: string | null;
  focusedAgentId: string | null;

  startExecution: (plan: ExecutionPlan) => void;
  /**
   * Ingest a `run_plan` batch. The first batch of a turn starts a fresh
   * execution; a later batch with the *same* execution id (the adaptive D1′
   * case where the CEO delegates again) is merged in — new agents/runs are
   * appended and the frame stream is kept — so every batch stays on the graph
   * and timeline. `clearExecution` between turns still gives each turn a fresh
   * graph, so cross-turn batches never merge.
   */
  ingestPlan: (plan: ExecutionPlan) => void;
  clearExecution: () => void;
  recordFrame: (frame: RunFrame) => void;
  setStatus: (status: ExecutionStatus) => void;
  setPlayhead: (index: number | null) => void;
  goLive: () => void;
  focusRun: (runId: string | null) => void;
  focusAgent: (agentId: string | null) => void;
  clearFocus: () => void;
}

export const useExecutionStore = create<ExecutionState>((set, get) => ({
  plan: null,
  frames: [],
  playhead: null,
  status: "planning",
  focusedRunId: null,
  focusedAgentId: null,

  startExecution: (plan) =>
    set({
      plan,
      frames: [],
      playhead: null,
      status: "running",
      focusedRunId: null,
      focusedAgentId: null,
    }),

  ingestPlan: (plan) => {
    const cur = get().plan;
    // Different turn / first batch → fresh start (resets frames + focus).
    if (!cur || cur.id !== plan.id) {
      get().startExecution(plan);
      return;
    }
    // Same execution → an incremental delegate batch. Append unseen agents and
    // runs (run-ids are namespaced per delegate call, so no collisions) while
    // preserving the existing frame stream, playhead and focus.
    const agents = [...cur.agents];
    for (const a of plan.agents) {
      if (!agents.some((x) => x.id === a.id)) agents.push(a);
    }
    const runs = [...cur.runs];
    for (const s of plan.runs) {
      if (!runs.some((x) => x.id === s.id)) runs.push(s);
    }
    set({
      plan: {
        ...cur,
        agents,
        runs,
        taskSummary: plan.taskSummary || cur.taskSummary,
      },
      status: "running",
    });
  },

  clearExecution: () =>
    set({
      plan: null,
      frames: [],
      playhead: null,
      status: "planning",
      focusedRunId: null,
      focusedAgentId: null,
    }),

  // Frames only carry meaning inside an execution; ignore stray run/tool facts
  // from the single-agent path (no plan declared).
  recordFrame: (frame) => {
    if (!get().plan) return;
    set((state) => ({ frames: [...state.frames, frame] }));
  },

  setStatus: (status) => set({ status }),

  setPlayhead: (index) => set({ playhead: index }),

  goLive: () => set({ playhead: null }),

  focusRun: (runId) => {
    if (runId === null) {
      set({ focusedRunId: null, focusedAgentId: null });
      return;
    }
    const agentId =
      get().plan?.runs.find((s) => s.id === runId)?.agentId ?? null;
    set({ focusedRunId: runId, focusedAgentId: agentId });
  },

  focusAgent: (agentId) => set({ focusedAgentId: agentId, focusedRunId: null }),

  clearFocus: () => set({ focusedRunId: null, focusedAgentId: null }),
}));

/**
 * The execution snapshot at the current playhead. Returns the live state while
 * following the tail, or the historical projection while scrubbing.
 */
export function useProjectedExecution(): Execution | null {
  const plan = useExecutionStore((s) => s.plan);
  const frames = useExecutionStore((s) => s.frames);
  const playhead = useExecutionStore((s) => s.playhead);
  const status = useExecutionStore((s) => s.status);

  return useMemo(() => {
    if (!plan) return null;
    const upto = playhead ?? frames.length;
    return projectExecution(plan, frames.slice(0, upto), status);
  }, [plan, frames, playhead, status]);
}
