// ProjectedTurn — the platform-neutral, serializable normalized turn state that is
// the conformance JUDGE (手机端落地设计 §六; protocol-conformance.mdc). Each end
// implements `fold(events[]) → ProjectedTurn` and must match the backend-projected
// golden for every vector. Internal store shapes may differ (desktop's Zustand
// `Execution` vs mobile's reducer) — only this snapshot is asserted equal.
//
// Shape mirrors the rule's `{ messages, runs(tree), status, pendingInteraction,
// cost }`, grounded in the two proven projections it must agree with: the desktop
// `projectExecution` fold (runs/agents/progress — stores/execution.ts) and the
// backend `EventSink._accumulate_process` fold (the single-agent process timeline —
// runtime/events.py). The backend oracle (runtime/conformance/projection.py) is the
// single source that emits the golden in exactly this shape.
//
// Wire-shaped leaves (usage/cost/process step / arguments) are carried VERBATIM from
// the SSE payloads (snake_case kept) so the fold copies them without lossy transforms;
// the structural turn state around them is camelCase.

import type {
  ContextBlockWire,
  CostBreakdown,
  DebateNarrativeRound,
  DebateResultPayload,
  ProcessStep,
  RunKind,
  Stance,
  UsageBreakdown,
} from "@agentcore/contract-types";

export type {
  ContextBlockWire,
  CostBreakdown,
  DebateNarrativeRound,
  DebateResultPayload,
  ProcessStep,
  UsageBreakdown,
};

/** Turn-level lifecycle, the single fold of desktop's ExecutionStatus + the chat
 * turn's own state. `running` until a gate (→ `paused`) or the terminal event:
 * message_end's finish_reason / an `error` event map to completed/failed/cancelled. */
export type TurnStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ModelTier = "fast" | "strong";
export type ReasoningEffort = "high" | "max" | null;

/** A web source consulted for the assistant message (citations event). */
export interface ProjectedCitation {
  url: string;
  title: string;
  snippet?: string;
  site?: string;
}

/** A delegated worker's live state (mirrors desktop AgentState, with the streamed
 * chunk arrays normalized to joined strings for a serializable snapshot). */
export interface ProjectedAgent {
  id: string;
  role: string;
  modelPreference: ModelTier;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  status: "idle" | "working" | "completed" | "error" | "cancelled";
  currentRunId: string | null;
  output: string;
  reasoning: string;
  toolProgress: { toolName: string; chars: number } | null;
}

/** A `checkpoint_after` pause on a run (plan_review, 结构化挂起 2a). */
export interface ProjectedRunCheckpoint {
  status: "pending" | "resolved";
  decision: "continue" | "adjust" | "stop" | "timeout" | null;
}

/** 升级实时可见: one escalation a worker raised mid-run via `escalate` (its only upward
 * channel to the CEO). `question` is the self-contained ask; `assumption` is what the
 * worker proceeded on meanwhile (escalate 非阻塞 — it kept working); `blocking` flags that
 * a wrong guess would void its product. Folded onto its {@link ProjectedRun} from the
 * `run_escalation` event so every end's node carries the same ⚠️ signal. */
export interface RunEscalation {
  question: string;
  assumption: string;
  blocking: boolean;
}

/** One node in the team graph (mirrors desktop RunNode — stores/execution.ts). The
 * tree is encoded by `parentRunId`; `usage`/`cost` ride verbatim from run_completed. */
export interface ProjectedRun {
  id: string;
  agentId: string;
  task: string;
  status: RunStatus;
  dependsOn: string[];
  outputSummary: string | null;
  durationMs: number | null;
  error: string | null;
  parentRunId: string | null;
  kind: RunKind;
  role: string | null;
  model: string | null;
  usage: UsageBreakdown | null;
  cost: CostBreakdown | null;
  stance: Stance | null;
  group: string | null;
  round: number;
  revisionOf: string | null;
  revision: number;
  checkpoint: ProjectedRunCheckpoint | null;
  /** 收到的上下文 (上下文传递可视化): the structured context blocks this run was fed at
   * assembly time (from its `run_context` event), carried VERBATIM (wire-shaped
   * snake_case) — the SAME data the LLM saw. Empty until that event folds in (or for a
   * run whose opening was not block-assembled). */
  receivedContext: ContextBlockWire[];
  /** 升级实时可见: escalations this run raised via `escalate`, in fire order (`run_escalation`
   * events). Empty for the common case; non-empty drives every end's node ⚠️ badge + live
   * notice. Transport-only on the wire — the durable copy rides RunState.escalations. */
  escalations: RunEscalation[];
}

/** A pending user gate — the one surface the turn is blocked on (`paused`). Only the
 * GATING interactions (approval / ask_user checkpoint / plan_review) appear; the
 * non-blocking `question_posted` never gates so it is not represented here. */
export type PendingInteraction =
  | {
      kind: "approval";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      kind: "checkpoint";
      checkpointId: string;
      question: string;
      context: string;
    }
  | {
      kind: "plan_review";
      checkpointId: string;
      runIds: string[];
    };

export interface ProjectedTurn {
  status: TurnStatus;
  /** message_end.finish_reason (end_turn / max_rounds / degraded / unproductive /
   * error / cancelled), or null while the turn is still streaming. */
  finishReason: string | null;
  /** The assistant bubble: the CEO captain's reply text + thinking (always, even in
   * a multi-agent turn where the captain speaks above the team graph). */
  content: string;
  reasoning: string;
  /** 收到的上下文 · CEO 侧 (上下文传递可视化, 通道①): the structured context the CEO captain
   * was fed at assembly time — `system` (本回合系统提示，决策②默认隐藏) / `history` / `request`
   * — from its `run_context` event (run_started kind=`captain`). Turn-level, NOT a graph
   * node: the captain is the bubble above the graph, so this shows on EVERY turn (pure chat
   * included), not only when it delegates. Empty until that event folds in. */
  captainContext: ContextBlockWire[];
  /** Single-agent 思考·正文·工具 inline timeline. Empty for a multi-agent turn (the
   * team graph carries the activity instead — parity with EventSink.process_timeline
   * returning None once run_plan fired). */
  process: ProcessStep[];
  citations: ProjectedCitation[];
  /** Team graph (empty for a single-agent turn). */
  agents: ProjectedAgent[];
  runs: ProjectedRun[];
  /** Derived from run states (terminal-completed over total), cumulative across
   * multi-batch delegates — never the per-batch run_progress counters. */
  progress: { completed: number; total: number };
  pendingInteraction: PendingInteraction | null;
  /** Turn total from message_end.cost (回合总账); null until the turn ends or when no
   * turn ran (error/not-found paths). */
  cost: CostBreakdown | null;
  /** The structured product of a 辩论 that concluded this turn (the `debate_result`
   * event), carried VERBATIM (snake_case kept) — the decision brief + clash
   * narrative the debate view renders, keyed to the graph's debater runs by
   * `run_id`. Null for a turn that ran no debate. */
  debate: DebateResultPayload | null;
  /** 辩论进行中的逐轮叙事（`debate_round_started` / `debate_round` 折叠累积）：让前端进行中
   * 就叠出主持人逐轮焦点 / 小结 / 裁判，而非干等 {@link debate} 收场。Transport-only 事件，
   * 故重载（journal 无逐轮事件）恒为 `[]`——届时全量叙事线已在 {@link debate} 里。非辩论恒 `[]`。 */
  debateRounds: DebateNarrativeRound[];
}
