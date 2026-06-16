import type {
  CheckpointDecision,
  CostBreakdown,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunKind,
  RunOutputDeltaPayload,
  RunPlanPayload,
  RunProgressPayload,
  RunReasoningDeltaPayload,
  RunStartedPayload,
  SSEEvent,
  Stance,
  ToolUseEndPayload,
  ToolUseStartPayload,
  UsageBreakdown,
} from "@/types/events";
import { createContext, useContext, useMemo } from "react";
import { create } from "zustand";

// Re-exported so graph/detail components import the debate display contract from
// the store (alongside MODEL_TIER_META) without reaching into the wire types.
export type { Stance } from "@/types/events";

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

/** Display labels for a 辩论/审查 side (前端UX目标态 §四) — the single source the
 * graph node badge and the strip title share, so正/反 read consistently. */
export const STANCE_META: Record<Stance, { label: string; short: string }> = {
  pro: { label: "正方", short: "正" },
  con: { label: "反方", short: "反" },
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

/** A structured DAG checkpoint (plan_review, 结构化挂起 2a) that paused the scheduler
 * *after* a run completed and *before* its dependents ran. `decision` is null while
 * the user has not answered; on resolve it records 继续/停止 (`continue`/`stop`; an
 * engine timeout folds in as `timeout`). Drives the node's pause badge. */
export interface RunCheckpoint {
  status: "pending" | "resolved";
  decision: CheckpointDecision | null;
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
  /** Node kind from `run_started` / the plan: `captain` is the CEO root 汇聚点,
   * `agent` a delegated worker. Drives how the graph styles the node. */
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
  /** 辩论/审查 呈现标记 (前端UX目标态 §四, display-only): this run's side in an
   * opposing batch (`pro`/`con`), the `group` it is paired in, and its `round`
   * (真·多轮辩论 turn, 1-based; 0 = not multi-round); null/0 for ordinary parallel/
   * DAG work. The only client signal that differentiates a debate from普通并行 — the
   * DAG shape + SSE are identical (守住「形状是数据不是模式」). Drives the node side
   * badge, the「辩论」strip title, the graph 分列, and the逐轮 layout. */
  stance: Stance | null;
  group: string | null;
  round: number;
  /** 定向唤回 续写 (乙 热修 P4): the ORIGINAL run id this node revises, or null for a
   * first-time run. A revision is NOT in the run_plan — it is synthesized into the
   * projection from its `run_started` frame and hung off the original as a
   *「修订 vN」child (distinct from a 阶段2 delegation, which is plan-declared). */
  revisionOf: string | null;
  /** Version number of a revision (original = v1, first revision = v2…); 0 for a
   * first-time run. From the wire `revision` flag. */
  revision: number;
  /** A `checkpoint_after` pause that fired *after* this run (plan_review, 结构化挂起
   * 2a); null for a run that never gated. Surfaced as a node pause badge so the
   * graph shows where the scheduler stopped for the user. */
  checkpoint: RunCheckpoint | null;
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
  runs: {
    id: string;
    agentId: string;
    task: string;
    dependsOn: string[];
    /** Delegating run id (阶段2 nested delegation). A sub-worker points at its
     * captain worker's run id (a real node) so the graph + detail tree group it
     * under that parent; a top-level worker points at the CEO captain run (no
     * node here) or is null. Declared at plan time so the *structural* graph
     * layout can group without waiting for the run_started frame. */
    parentRunId?: string | null;
    /** Declared node kind (default `agent`). `captain` marks the CEO root 汇聚点;
     * also re-confirmed by the run_started frame. */
    kind?: RunKind;
    /** 辩论/审查 呈现标记 (前端UX目标态 §四, display-only): opposing-side tag,
     * pairing group, and 真·多轮辩论 turn (`round`). Declared at plan time so the
     * strip can show a「辩论」title and the graph can band正/反 + 逐轮 from the plan
     * alone, before any run frame folds in. */
    stance?: Stance;
    group?: string;
    round?: number;
  }[];
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
      // carries the wire `kind` (captain/agent).
      parentRunId: string | null;
      runKind: RunKind;
      // 续写 version (乙 热修 P4): 0 for an ordinary run, >=2 for a revision (then
      // parentRunId is the original run it revises).
      revision: number;
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
    }
  | {
      t: number;
      kind: "plan_review_required";
      checkpointId: string;
      // The just-completed step run ids this pause gates on (the badge targets).
      runIds: string[];
    }
  | {
      t: number;
      kind: "plan_review_resolved";
      checkpointId: string;
      decision: CheckpointDecision;
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
    // Plan-declared parent so the 子任务 tree + graph grouping work before the
    // run_started frame folds in (the frame re-confirms it). 阶段1 flat workers
    // resolve to a CEO-captain id with no node, treated as "no parent here".
    parentRunId: s.parentRunId ?? null,
    // Plan-declared kind so the captain 汇聚点 is identifiable before its
    // run_started frame folds in (the frame re-confirms it).
    kind: s.kind ?? "agent",
    role: null,
    model: null,
    usage: null,
    cost: null,
    // 辩论/审查 display tags ride straight from the plan (no run frame mutates
    // them — they are declared once and immutable).
    stance: s.stance ?? null,
    group: s.group ?? null,
    round: s.round ?? 0,
    // Plan runs are never revisions; a revision is synthesized from its frame.
    revisionOf: null,
    revision: 0,
    // No checkpoint until a plan_review frame folds in (结构化挂起 2a).
    checkpoint: null,
  }));

  const agentById = (id: string) => agents.find((a) => a.id === id);
  const runById = (id: string) => runs.find((s) => s.id === id);

  // plan_review_resolved carries only the checkpoint id, so remember which step
  // run ids each pause gated on (from its _required frame) to apply the decision.
  const checkpointSteps = new Map<string, string[]>();

  for (const f of frames) {
    switch (f.kind) {
      case "run_started": {
        let run = runById(f.runId);
        // 定向唤回 续写 (乙 热修 P4): a revision (`revision >= 2`) is NOT in the plan —
        // it is born from this frame. Synthesize its run + agent, inheriting the
        // ORIGINAL's display identity (role / tier / task), and hang it off the
        // original as a「修订 vN」child so its output / cost / status fold in just
        // like a planned worker. Guarded on the original existing, so a stray
        // revision frame (parent not on this graph) is ignored, not mis-drawn.
        if (!run && f.revision > 0 && f.parentRunId) {
          const original = runById(f.parentRunId);
          if (original) {
            const originAgent = agentById(original.agentId);
            agents.push({
              id: f.agentId,
              role: originAgent?.role ?? original.agentId,
              modelPreference: originAgent?.modelPreference ?? "strong",
              thinking: originAgent?.thinking ?? true,
              reasoningEffort: originAgent?.reasoningEffort ?? "high",
              status: "idle",
              currentRunId: null,
              outputChunks: [],
              reasoningChunks: [],
              toolCalls: [],
            });
            run = {
              id: f.runId,
              agentId: f.agentId,
              task: original.task,
              status: "pending",
              dependsOn: [],
              outputSummary: null,
              durationMs: null,
              error: null,
              parentRunId: f.parentRunId,
              kind: f.runKind,
              role: null,
              model: null,
              usage: null,
              cost: null,
              stance: null,
              group: null,
              round: 0,
              revisionOf: f.parentRunId,
              revision: f.revision,
              checkpoint: null,
            };
            runs.push(run);
          }
        }
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
      case "plan_review_required": {
        // 结构化挂起 2a: the scheduler paused after these step(s) completed; mark
        // them pending so the node shows a「待放行」badge.
        checkpointSteps.set(f.checkpointId, f.runIds);
        for (const id of f.runIds) {
          const run = runById(id);
          if (run) run.checkpoint = { status: "pending", decision: null };
        }
        break;
      }
      case "plan_review_resolved": {
        for (const id of checkpointSteps.get(f.checkpointId) ?? []) {
          const run = runById(id);
          if (run) {
            run.checkpoint = { status: "resolved", decision: f.decision };
          }
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
    case "plan_review_required":
      return "执行暂停 · 待你放行";
    case "plan_review_resolved":
      return frame.decision === "stop"
        ? "已停止 · 未运行下游"
        : "已放行 · 继续";
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

/**
 * Whether a turn is a 辩论/审查 (前端UX目标态 §四): any run carries a stance tag.
 *
 * This is the single client-side signal that differentiates a debate from an
 * ordinary parallel batch — the DAG shape and SSE are identical (守住「形状是数据
 * 不是模式」), so the strip title / node badge / graph 分列 all key off it.
 */
export function isDebate(execution: Execution): boolean {
  return execution.runs.some((r) => r.stance != null);
}

/**
 * The debate roster split by side (前端UX目标态 §四), in plan order. Empty lists
 * for a non-debate turn. Used by the strip title now and the「左右并排对比」next.
 */
export function debateSides(execution: Execution): {
  pro: RunNode[];
  con: RunNode[];
} {
  return {
    pro: execution.runs.filter((r) => r.stance === "pro"),
    con: execution.runs.filter((r) => r.stance === "con"),
  };
}

/** One round's 正/反 within a comparison group (真·多轮辩论, 前端UX目标态 §四).
 * `round` is the 1-based turn; 0 means the group carries no round tags (即单轮辩论). */
export interface DebateRound {
  round: number;
  pro: RunNode[];
  con: RunNode[];
}

/** One comparison group: its full 正/反 rosters plus the same runs re-bucketed by
 * `round` (升序). A single-round group yields one bucket at round 0. */
export interface DebateGroup {
  key: string;
  pro: RunNode[];
  con: RunNode[];
  rounds: DebateRound[];
}

/**
 * The debate split into comparison groups (前端UX目标态 §四), one per `group` tag
 * (an untagged stance falls into the default `""` group), in first-seen order.
 * Powers the「左右并排对比」card: a turn can hold several opposing pairs (multi-
 * dimension review), each rendered as its own 正方 vs 反方 row. Empty for非辩论.
 *
 * Each group also carries its `rounds` — the same runs re-bucketed by `round`
 * (真·多轮辩论) in ascending turn order. The card lays a multi-round group out 逐轮
 * and a single-round one (all round 0) as a flat 正/反 pair, both off this one
 * projection — no second source of truth.
 */
export function debateGroups(execution: Execution): DebateGroup[] {
  const groups: DebateGroup[] = [];
  for (const run of execution.runs) {
    if (run.stance == null) continue;
    const key = run.group ?? "";
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, pro: [], con: [], rounds: [] };
      groups.push(group);
    }
    (run.stance === "pro" ? group.pro : group.con).push(run);
    let bucket = group.rounds.find((r) => r.round === run.round);
    if (!bucket) {
      bucket = { round: run.round, pro: [], con: [] };
      group.rounds.push(bucket);
    }
    (run.stance === "pro" ? bucket.pro : bucket.con).push(run);
  }
  for (const group of groups) {
    group.rounds.sort((a, b) => a.round - b.round);
  }
  return groups;
}

/** One version in a revision chain (乙 热修 P4): the original is `version` 1, each
 * 续写 carries its own `version` (2, 3…). `run` is the projected node for that
 * version, so the compare card reads its output / status / role straight off it. */
export interface RevisionVersion {
  version: number;
  run: RunNode;
}

/** A revised worker's full version chain (乙 热修 P4): the original plus every
 *「修订 vN」续写 of it, in version order (v1 first). */
export interface RevisionChain {
  originalId: string;
  versions: RevisionVersion[];
}

/** Whether any worker in the turn was 定向唤回 revised — the single signal that
 * gates the「版本对比」card + the graph's revision styling (mirrors {@link isDebate}
 * for debates). */
export function hasRevisions(execution: Execution): boolean {
  return execution.runs.some((r) => r.revisionOf != null);
}

/**
 * Group the turn's runs into revision chains (乙 热修 P4), one per revised original
 * (in first-seen original order). Each chain is the original (v1) followed by its
 * 续写 versions in ascending version order — the projection the「版本对比」card lays
 * out side by side. Originals with no revision are omitted (a chain needs ≥2
 * versions to compare); a stray revision whose original is absent is dropped.
 */
export function revisionChains(execution: Execution): RevisionChain[] {
  const revisionsByOriginal = new Map<string, RunNode[]>();
  for (const run of execution.runs) {
    if (run.revisionOf == null) continue;
    const list = revisionsByOriginal.get(run.revisionOf) ?? [];
    list.push(run);
    revisionsByOriginal.set(run.revisionOf, list);
  }
  const chains: RevisionChain[] = [];
  for (const run of execution.runs) {
    const revisions = revisionsByOriginal.get(run.id);
    // Iterate originals (revisionOf == null) so each chain is built once, in
    // graph order; a revision node itself is skipped here.
    if (run.revisionOf != null || !revisions) continue;
    const versions: RevisionVersion[] = [
      { version: 1, run },
      ...revisions
        .slice()
        .sort((a, b) => a.revision - b.revision)
        .map((r) => ({ version: r.revision, run: r })),
    ];
    chains.push({ originalId: run.id, versions });
  }
  return chains;
}

/**
 * A persisted multi-agent execution journal for one assistant message
 * (`messages.runs`): the turn's ordered run/tool SSE events plus its finish
 * reason. Replayed client-side through the same fold as the live stream to
 * rebuild a past turn's team graph on reload. Carried on {@link Message.runs};
 * absent for user / single-agent messages (no delegation).
 */
export interface ExecutionJournal {
  events: SSEEvent[];
  finishReason: string;
}

/** Wall-clock time of a wire event (ms), used to label timeline frames. The
 * journal stores the same ISO timestamp the live stream carried, so replay and
 * live label frames identically. */
function frameTimeOf(event: SSEEvent): number {
  const parsed = Date.parse(event.timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Map a `run_plan` wire payload to the immutable plan skeleton. */
export function planFromRunPlan(p: RunPlanPayload): ExecutionPlan {
  return {
    id: p.execution_id,
    planType: p.plan_type,
    taskSummary: p.task_summary,
    agents: p.agents.map((a) => ({
      id: a.id,
      role: a.role,
      modelPreference: a.model_preference,
      thinking: a.thinking,
      reasoningEffort: a.reasoning_effort,
    })),
    runs: p.runs.map((s) => ({
      id: s.id,
      agentId: s.agent_id,
      task: s.task,
      dependsOn: s.depends_on,
      parentRunId: s.parent_run_id ?? null,
      kind: s.kind,
      stance: s.stance,
      group: s.group,
      round: s.round,
    })),
  };
}

/** Map a journaled run/tool SSE event to a {@link RunFrame}, or null for events
 * that are not frames (e.g. `run_plan`). The single event→frame mapping shared
 * by the live SSE dispatch and journal replay, so there is one fold, not two. */
export function frameFromEvent(event: SSEEvent): RunFrame | null {
  const t = frameTimeOf(event);
  switch (event.type) {
    case "run_started": {
      const p = event.payload as RunStartedPayload;
      return {
        t,
        kind: "run_started",
        agentId: p.agent_id,
        runId: p.run_id,
        parentRunId: p.parent_run_id,
        runKind: p.kind,
        revision: p.revision ?? 0,
      };
    }
    case "run_output_delta": {
      const p = event.payload as RunOutputDeltaPayload;
      return {
        t,
        kind: "run_output_delta",
        agentId: p.agent_id,
        delta: p.delta,
      };
    }
    case "run_reasoning_delta": {
      const p = event.payload as RunReasoningDeltaPayload;
      return {
        t,
        kind: "run_reasoning_delta",
        agentId: p.agent_id,
        delta: p.delta,
      };
    }
    case "run_completed": {
      const p = event.payload as RunCompletedPayload;
      return {
        t,
        kind: "run_completed",
        runId: p.run_id,
        agentId: p.agent_id,
        outputSummary: p.output_summary,
        durationMs: p.duration_ms,
        role: p.role,
        model: p.model,
        usage: p.usage,
        cost: p.cost,
      };
    }
    case "run_failed": {
      const p = event.payload as RunFailedPayload;
      return {
        t,
        kind: "run_failed",
        runId: p.run_id,
        agentId: p.agent_id,
        error: p.error,
      };
    }
    case "run_progress": {
      const p = event.payload as RunProgressPayload;
      return {
        t,
        kind: "run_progress",
        completed: p.completed,
        total: p.total,
      };
    }
    case "tool_use_start": {
      const p = event.payload as ToolUseStartPayload;
      return {
        t,
        kind: "tool_use_start",
        toolCallId: p.tool_call_id,
        toolName: p.tool_name,
        arguments: p.arguments,
      };
    }
    case "tool_use_end": {
      const p = event.payload as ToolUseEndPayload;
      return {
        t,
        kind: "tool_use_end",
        toolCallId: p.tool_call_id,
        result: p.result,
        status: p.status,
      };
    }
    case "plan_review_required": {
      const p = event.payload as PlanReviewRequiredPayload;
      return {
        t,
        kind: "plan_review_required",
        checkpointId: p.checkpoint_id,
        runIds: (p.steps ?? []).map((s) => s.run_id),
      };
    }
    case "plan_review_resolved": {
      const p = event.payload as PlanReviewResolvedPayload;
      return {
        t,
        kind: "plan_review_resolved",
        checkpointId: p.checkpoint_id,
        decision: p.decision,
      };
    }
    default:
      return null;
  }
}

/** Merge a later same-turn delegate batch into the current plan: append unseen
 * agents/runs (ids are namespaced per delegate call), keep the first batch's
 * task summary unless the new one is non-empty. Shared by {@link ingestPlan}
 * (live) and journal replay (history). */
function mergePlanInto(cur: ExecutionPlan, next: ExecutionPlan): ExecutionPlan {
  const agents = [...cur.agents];
  for (const a of next.agents) {
    if (!agents.some((x) => x.id === a.id)) agents.push(a);
  }
  const runs = [...cur.runs];
  for (const s of next.runs) {
    if (!runs.some((x) => x.id === s.id)) runs.push(s);
  }
  return {
    ...cur,
    agents,
    runs,
    taskSummary: next.taskSummary || cur.taskSummary,
  };
}

/** Map a persisted turn's `finish_reason` to the terminal execution status the
 * fold needs (a journal is only stored for finished turns). */
function statusFromFinish(finishReason: string): ExecutionStatus {
  if (finishReason === "error") return "failed";
  if (finishReason === "cancelled") return "cancelled";
  return "completed";
}

/**
 * The execution state of a single assistant message's turn — plan, frame
 * stream, playhead and cross-view focus. Keyed by assistant message id so every
 * past multi-agent turn in a conversation keeps its own graph: the live turn
 * streams frames into its message's slot, and a reloaded turn hydrates its slot
 * once from the persisted journal.
 */
export interface ExecutionRuntime {
  plan: ExecutionPlan | null;
  frames: RunFrame[];
  /** Number of frames to project. `null` = follow the live tail. */
  playhead: number | null;
  status: ExecutionStatus;
}

/**
 * Every mutator targets one assistant message's {@link ExecutionRuntime} by id.
 * SSE dispatch resolves the live turn's assistant message id and routes frames
 * there; view interactions (focus / playhead) pass the message id of the graph
 * subtree they belong to ({@link useExecutionScope}).
 */
interface ExecutionState {
  byId: Record<string, ExecutionRuntime>;

  startExecution: (plan: ExecutionPlan, messageId: string) => void;
  /**
   * Ingest a `run_plan` batch. The first batch of a turn starts a fresh
   * execution; a later batch with the *same* execution id (the adaptive D1′
   * case where the CEO delegates again) is merged in — new agents/runs are
   * appended and the frame stream is kept — so every batch stays on the graph
   * and timeline. A new turn produces a new assistant message (new slot), so
   * cross-turn batches never merge.
   */
  ingestPlan: (plan: ExecutionPlan, messageId: string) => void;
  clearExecution: (messageId: string) => void;
  recordFrame: (frame: RunFrame, messageId: string) => void;
  setStatus: (status: ExecutionStatus, messageId: string) => void;
  setPlayhead: (index: number | null, messageId: string) => void;
  goLive: (messageId: string) => void;
  /**
   * Fold a persisted execution journal (`messages.runs`) into a message's slot,
   * reproducing the team graph a past multi-agent turn had — replayed through
   * the same fold as the live stream. Idempotent: a slot that already holds a
   * plan (a live turn, or an earlier hydrate) is left untouched, so a re-render
   * or a late history fetch never clobbers live frames.
   */
  hydrateFromJournal: (messageId: string, journal: ExecutionJournal) => void;
}

const EMPTY_EXEC: ExecutionRuntime = {
  plan: null,
  frames: [],
  playhead: null,
  status: "planning",
};

/**
 * The execution runtime of an assistant message, never undefined (empty
 * default). Use this for imperative reads (`getState`, tests); components
 * subscribe via {@link useProjectedExecution} / {@link useActiveExecField}
 * (scoped to the in-context message) so a conversation switch re-renders.
 */
export function execRuntime(
  state: ExecutionState,
  messageId: string | null | undefined,
): ExecutionRuntime {
  return (messageId ? state.byId[messageId] : undefined) ?? EMPTY_EXEC;
}

export const useExecutionStore = create<ExecutionState>((set, get) => {
  /** Patch one message's runtime slice, lazily created from empty. */
  const patchExec = (
    messageId: string,
    update: (cur: ExecutionRuntime) => Partial<ExecutionRuntime> | null,
  ) =>
    set((state) => {
      const cur = state.byId[messageId] ?? EMPTY_EXEC;
      const patch = update(cur);
      if (patch === null) return {};
      return { byId: { ...state.byId, [messageId]: { ...cur, ...patch } } };
    });

  return {
    byId: {},

    startExecution: (plan, messageId) =>
      patchExec(messageId, () => ({
        plan,
        frames: [],
        playhead: null,
        status: "running",
      })),

    ingestPlan: (plan, messageId) => {
      const cur = execRuntime(get(), messageId).plan;
      // Different turn / first batch → fresh start (resets frames).
      if (!cur || cur.id !== plan.id) {
        get().startExecution(plan, messageId);
        return;
      }
      // Same execution → an incremental delegate batch: merge in unseen
      // agents/runs while keeping the existing frame stream and playhead.
      patchExec(messageId, () => ({
        plan: mergePlanInto(cur, plan),
        status: "running",
      }));
    },

    clearExecution: (messageId) =>
      patchExec(messageId, () => ({ ...EMPTY_EXEC })),

    // Frames only carry meaning inside an execution; ignore stray run/tool facts
    // from the single-agent path (no plan declared).
    recordFrame: (frame, messageId) =>
      patchExec(messageId, (cur) =>
        cur.plan ? { frames: [...cur.frames, frame] } : null,
      ),

    setStatus: (status, messageId) => patchExec(messageId, () => ({ status })),

    setPlayhead: (index, messageId) =>
      patchExec(messageId, () => ({ playhead: index })),

    goLive: (messageId) => patchExec(messageId, () => ({ playhead: null })),

    hydrateFromJournal: (messageId, journal) =>
      set((state) => {
        // Idempotent: never clobber a live turn's slot or an earlier hydrate.
        if (state.byId[messageId]?.plan) return {};
        let plan: ExecutionPlan | null = null;
        const frames: RunFrame[] = [];
        for (const event of journal.events) {
          if (event.type === "run_plan") {
            const next = planFromRunPlan(event.payload as RunPlanPayload);
            plan = plan ? mergePlanInto(plan, next) : next;
          } else {
            const frame = frameFromEvent(event);
            if (frame) frames.push(frame);
          }
        }
        // No run_plan in the journal → nothing to draw (single-agent / stray).
        if (!plan) return {};
        return {
          byId: {
            ...state.byId,
            [messageId]: {
              plan,
              frames,
              playhead: null,
              status: statusFromFinish(journal.finishReason),
            },
          },
        };
      }),
  };
});

/**
 * The assistant message id whose team graph the current subtree renders.
 * Provided by {@link InlineTeamGraph} (inline graph) and the detail panel
 * (run-detail tab); the scoped hooks below read it so every graph view targets
 * the right message's slot — live or replayed — through one code path.
 */
export const ExecutionScopeContext = createContext<string | null>(null);

/** The in-scope message id (see {@link ExecutionScopeContext}). */
export function useExecutionScope(): string | null {
  return useContext(ExecutionScopeContext);
}

/** Project a specific message's execution at its current playhead — live tail
 * or replay. Used where the message id is explicit (the inline graph + panel). */
export function useMessageExecution(
  messageId: string | null,
): Execution | null {
  const rt = useExecutionStore((s) =>
    messageId ? s.byId[messageId] : undefined,
  );
  return useMemo(() => {
    if (!rt?.plan) return null;
    const upto = rt.playhead ?? rt.frames.length;
    return projectExecution(rt.plan, rt.frames.slice(0, upto), rt.status);
  }, [rt]);
}

/**
 * Subscribe to one field of the in-scope message's execution runtime
 * ({@link ExecutionScopeContext}). Re-renders when that field changes or the
 * scope switches. Prefer this over reading the store directly.
 */
export function useActiveExecField<T>(
  selector: (rt: ExecutionRuntime) => T,
): T {
  const messageId = useContext(ExecutionScopeContext);
  return useExecutionStore((s) =>
    selector((messageId ? s.byId[messageId] : undefined) ?? EMPTY_EXEC),
  );
}

/**
 * The in-scope message's execution snapshot at the current playhead — live
 * while following the tail, historical while scrubbing. Reads the scope from
 * {@link ExecutionScopeContext}.
 */
export function useProjectedExecution(): Execution | null {
  return useMessageExecution(useContext(ExecutionScopeContext));
}
