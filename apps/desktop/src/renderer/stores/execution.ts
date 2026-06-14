import { useMemo } from "react";
import { create } from "zustand";

export type StepStatus =
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
  | "failed";

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
    description: "思考·high、回合预算大，面向需要判断或对质量有要求的子任务；可经「深度」升 max。",
  },
};

/**
 * Effective reasoning effort (提案 B). `null` = non-thinking; no worker tier is
 * non-thinking anymore (dev-stage: both tiers think at `high`), so this only
 * appears for background mechanical roles. Mirrors the backend `reasoning_effort`
 * after `apply_overrides`.
 */
export type ReasoningEffort = "high" | "max" | null;

/**
 * Resolve the effective (thinking, effort) the UI shows/sends for an agent, from
 * its tier and a single "deep thinking" intent. Mirrors backend
 * `llm.config.apply_overrides`: both tiers think at 思考·high; the `deep` toggle
 * unlocks 思考·max on `strong` only (the documented 极复杂 upgrade). `fast` is the
 * no-max tier — to downgrade from max, switch tier to fast, never turn off here.
 */
export function deriveEffective(
  tier: ModelTier,
  deep: boolean,
): { thinking: boolean; reasoningEffort: ReasoningEffort } {
  if (tier === "fast") return { thinking: true, reasoningEffort: "high" };
  return deep
    ? { thinking: true, reasoningEffort: "max" }
    : { thinking: true, reasoningEffort: "high" };
}

/** Display label for the effective reasoning state — the single source the
 * preview, graph badge, and detail panel share. */
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
  status: "idle" | "working" | "completed" | "error";
  currentStepId: string | null;
  outputChunks: string[];
  toolCalls: ToolCallState[];
}

/**
 * Orchestrator checkpoint attached to a step. `decision` is the orchestrator's
 * verdict (continue / adjust / escalate). Only `escalate` is then handed to the
 * user, whose call lands in `action` (null while awaiting). So the lifecycle is:
 * continue/adjust → terminal; escalate → action null (待裁决) → approve/adjust/stop.
 */
export interface StepCheckpoint {
  id: string;
  reason: string;
  summary: string;
  decision: "continue" | "adjust" | "escalate";
  action: "approve" | "adjust" | "stop" | null;
}

export interface StepState {
  id: string;
  agentId: string;
  task: string;
  status: StepStatus;
  dependsOn: string[];
  outputSummary: string | null;
  durationMs: number | null;
  checkpoint: StepCheckpoint | null;
}

export interface Execution {
  id: string;
  planType: "single_agent" | "multi_agent";
  taskSummary: string;
  status: ExecutionStatus;
  agents: AgentState[];
  steps: StepState[];
  progress: { completed: number; total: number };
}

export interface PendingCheckpoint {
  checkpointId: string;
  afterStep: string;
  summary: string;
  reason: string;
  actions: ("approve" | "adjust" | "stop")[];
}

/**
 * The pre-execution team-preview gate. While set, the run is suspended on the
 * backend awaiting the user's "start" (with any tier overrides) or "cancel".
 * Tier edits during preview mutate the plan directly, so the graph badges and
 * the preview card stay in sync from one source.
 */
export interface PendingReview {
  reviewId: string;
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
  steps: { id: string; agentId: string; task: string; dependsOn: string[] }[];
}

/**
 * One recorded run-level fact. The frame stream is append-only and is the
 * single source of truth for the collaboration graph — mirroring the backend
 * Turn Journal. "Live" is simply playhead = end-of-stream; "replay" is any
 * earlier playhead. Both render through the same {@link projectExecution} fold,
 * so there is no second code path to keep in sync.
 */
export type RunFrame =
  | { t: number; kind: "run_started"; agentId: string; stepId: string }
  | { t: number; kind: "run_output_delta"; agentId: string; delta: string }
  | {
      t: number;
      kind: "run_completed";
      stepId: string;
      agentId: string;
      outputSummary: string;
      durationMs: number;
    }
  | {
      t: number;
      kind: "run_failed";
      stepId: string;
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
    }
  | {
      t: number;
      kind: "checkpoint_review";
      checkpointId: string;
      stepId: string;
      decision: "continue" | "adjust" | "escalate";
      reason: string;
      summary: string;
    }
  | {
      t: number;
      kind: "checkpoint_resolved";
      checkpointId: string;
      action: "approve" | "adjust" | "stop";
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
    currentStepId: null,
    outputChunks: [],
    toolCalls: [],
  }));
  const steps: StepState[] = plan.steps.map((s) => ({
    id: s.id,
    agentId: s.agentId,
    task: s.task,
    status: "pending",
    dependsOn: s.dependsOn,
    outputSummary: null,
    durationMs: null,
    checkpoint: null,
  }));
  let progress = { completed: 0, total: plan.steps.length };

  const agentById = (id: string) => agents.find((a) => a.id === id);
  const stepById = (id: string) => steps.find((s) => s.id === id);

  for (const f of frames) {
    switch (f.kind) {
      case "run_started": {
        const step = stepById(f.stepId);
        if (step) step.status = "running";
        const agent = agentById(f.agentId);
        if (agent) {
          agent.status = "working";
          agent.currentStepId = f.stepId;
        }
        break;
      }
      case "run_output_delta": {
        const agent = agentById(f.agentId);
        if (agent) agent.outputChunks.push(f.delta);
        break;
      }
      case "run_completed": {
        const step = stepById(f.stepId);
        if (step) {
          step.status = "completed";
          step.outputSummary = f.outputSummary;
          step.durationMs = f.durationMs;
        }
        const agent = agentById(f.agentId);
        if (agent) {
          agent.status = "completed";
          agent.currentStepId = null;
        }
        break;
      }
      case "run_failed": {
        const step = stepById(f.stepId);
        if (step) step.status = "failed";
        const agent = agentById(f.agentId);
        if (agent) agent.status = "error";
        break;
      }
      case "run_progress": {
        progress = { completed: f.completed, total: f.total };
        break;
      }
      case "tool_use_start": {
        // Tool events are not run-scoped on the wire; attach to whichever step
        // is running at this point in the fold (matches prior live behaviour).
        const running = steps.find((s) => s.status === "running");
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
      case "checkpoint_review": {
        const step = stepById(f.stepId);
        if (step) {
          step.checkpoint = {
            id: f.checkpointId,
            reason: f.reason,
            summary: f.summary,
            decision: f.decision,
            action: null,
          };
        }
        break;
      }
      case "checkpoint_resolved": {
        const step = steps.find((s) => s.checkpoint?.id === f.checkpointId);
        if (step?.checkpoint) {
          step.checkpoint = { ...step.checkpoint, action: f.action };
        }
        break;
      }
    }
  }

  return {
    id: plan.id,
    planType: plan.planType,
    taskSummary: plan.taskSummary,
    status,
    agents,
    steps,
    progress,
  };
}

/** Human-readable label for a frame, used by the timeline scrubber. */
export function describeFrame(frame: RunFrame, plan: ExecutionPlan): string {
  const role = (agentId: string) =>
    plan.agents.find((a) => a.id === agentId)?.role ?? agentId;
  const task = (stepId: string) =>
    plan.steps.find((s) => s.id === stepId)?.task ?? stepId;

  switch (frame.kind) {
    case "run_started":
      return `${role(frame.agentId)} 开始 · ${task(frame.stepId)}`;
    case "run_output_delta":
      return `${role(frame.agentId)} 输出中…`;
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
    case "checkpoint_review": {
      const label =
        frame.decision === "continue"
          ? "编排器继续"
          : frame.decision === "adjust"
            ? "编排器调整"
            : "升级用户裁决";
      return `检查点 · ${label}（${task(frame.stepId)}）`;
    }
    case "checkpoint_resolved": {
      const label =
        frame.action === "approve"
          ? "继续"
          : frame.action === "adjust"
            ? "调整"
            : "停止";
      return `检查点 · 用户${label}`;
    }
  }
}

interface ExecutionState {
  plan: ExecutionPlan | null;
  frames: RunFrame[];
  /** Number of frames to project. `null` = follow the live tail. */
  playhead: number | null;
  status: ExecutionStatus;
  pendingCheckpoint: PendingCheckpoint | null;
  pendingReview: PendingReview | null;

  /**
   * Cross-view selection shared by the graph and the in-chat task card. A
   * step focus pins one node (and its agent); an agent focus highlights every
   * node that agent owns. Bridged through {@link ExecutionPlan} so either view
   * can drive the other even though they are never on screen at once.
   */
  focusedStepId: string | null;
  focusedAgentId: string | null;

  startExecution: (plan: ExecutionPlan) => void;
  clearExecution: () => void;
  recordFrame: (frame: RunFrame) => void;
  setStatus: (status: ExecutionStatus) => void;
  setPlayhead: (index: number | null) => void;
  goLive: () => void;
  setPendingCheckpoint: (checkpoint: PendingCheckpoint | null) => void;
  clearPendingCheckpoint: () => void;
  setPendingReview: (review: PendingReview | null) => void;
  clearPendingReview: () => void;
  /** Override one agent's model tier during preview (mutates the plan). */
  setAgentTier: (agentId: string, tier: ModelTier) => void;
  /** Toggle one agent's deep thinking (max effort) during preview (提案 B). */
  setAgentDeep: (agentId: string, deep: boolean) => void;
  focusStep: (stepId: string | null) => void;
  focusAgent: (agentId: string | null) => void;
  clearFocus: () => void;
}

export const useExecutionStore = create<ExecutionState>((set, get) => ({
  plan: null,
  frames: [],
  playhead: null,
  status: "planning",
  pendingCheckpoint: null,
  pendingReview: null,
  focusedStepId: null,
  focusedAgentId: null,

  startExecution: (plan) =>
    set({
      plan,
      frames: [],
      playhead: null,
      status: "running",
      pendingCheckpoint: null,
      pendingReview: null,
      focusedStepId: null,
      focusedAgentId: null,
    }),

  clearExecution: () =>
    set({
      plan: null,
      frames: [],
      playhead: null,
      status: "planning",
      pendingCheckpoint: null,
      pendingReview: null,
      focusedStepId: null,
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

  setPendingCheckpoint: (checkpoint) => set({ pendingCheckpoint: checkpoint }),
  clearPendingCheckpoint: () => set({ pendingCheckpoint: null }),

  setPendingReview: (review) => set({ pendingReview: review }),
  clearPendingReview: () => set({ pendingReview: null }),

  setAgentTier: (agentId, tier) =>
    set((state) => {
      if (!state.plan) return {};
      return {
        plan: {
          ...state.plan,
          agents: state.plan.agents.map((a) => {
            if (a.id !== agentId) return a;
            // Preserve the deep intent across a tier switch; fast has no max, so
            // it resolves to high (switching to fast is how you drop from max).
            const deep = a.reasoningEffort === "max";
            return {
              ...a,
              modelPreference: tier,
              ...deriveEffective(tier, deep),
            };
          }),
        },
      };
    }),

  setAgentDeep: (agentId, deep) =>
    set((state) => {
      if (!state.plan) return {};
      return {
        plan: {
          ...state.plan,
          agents: state.plan.agents.map((a) =>
            a.id === agentId
              ? { ...a, ...deriveEffective(a.modelPreference, deep) }
              : a,
          ),
        },
      };
    }),

  focusStep: (stepId) => {
    if (stepId === null) {
      set({ focusedStepId: null, focusedAgentId: null });
      return;
    }
    const agentId =
      get().plan?.steps.find((s) => s.id === stepId)?.agentId ?? null;
    set({ focusedStepId: stepId, focusedAgentId: agentId });
  },

  focusAgent: (agentId) =>
    set({ focusedAgentId: agentId, focusedStepId: null }),

  clearFocus: () => set({ focusedStepId: null, focusedAgentId: null }),
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
