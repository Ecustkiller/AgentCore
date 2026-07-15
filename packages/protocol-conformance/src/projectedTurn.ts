// ProjectedTurn — the platform-neutral, serializable normalized turn state that is
// the conformance JUDGE (前端技术与架构 §十二; protocol-conformance.mdc). Each end
// implements `fold(events[]) → ProjectedTurn` and must match the backend-projected
// golden for every vector. Internal store shapes may differ (desktop's Zustand
// `Execution` vs mobile's reducer) — only this snapshot is asserted equal.
//
// Shape mirrors the rule's `{ messages, runs(tree), status, interactions[],
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
  PlanRevisionKind,
  ProcessStep,
  RunDebrief,
  RunKind,
  Stance,
  TeamSynthesisPreviewPayload,
  UsageBreakdown,
} from "@agentcore/contract-types";

export type {
  ContextBlockWire,
  CostBreakdown,
  DebateNarrativeRound,
  DebateResultPayload,
  PlanRevisionKind,
  ProcessStep,
  RunDebrief,
  TeamSynthesisPreviewPayload,
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
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type ModelTier = "fast" | "strong";
export type ReasoningEffort = "high" | "max" | "low" | null;

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

/** A `checkpoint_after` pause on a run (plan_review, 结构化挂起 2a). `orphaned` =
 * 已失效 terminal (提问确认统一重构: the pending gate was invalidated by restart/recover). */
export interface ProjectedRunCheckpoint {
  status: "pending" | "resolved";
  decision: "continue" | "per_call" | "adjust" | "stop" | "timeout" | "orphaned" | null;
}

/** 升级实时可见 / 阻塞式求决策: one escalation a worker raised mid-run via `escalate` (its
 * only upward channel). `question` is the self-contained ask; `assumption` is what the worker
 * proceeds on; `blocking` flags that a wrong guess would void its product. Folded onto its
 * {@link ProjectedRun} so every end's node carries the same signal.
 *
 * `status` is the lifecycle (阻塞式求决策): `raised` = non-blocking banner; `pending` =
 * blocking parked; `resolved` = answered; `assumed` = explicit 按假设继续; `timed_out` =
 * wall-clock miss. `assumed` and `timed_out` both leave `answer` null (worker falls
 * back to assumption) but must stay distinct — conflating them made「点了按假设继续」
 * look like system timeout. */
export type EscalationKind = "normal" | "scope" | "dep";

export interface RunEscalation {
  question: string;
  assumption: string;
  blocking: boolean;
  status: "raised" | "pending" | "resolved" | "assumed" | "timed_out";
  answer: string | null;
  /** escalate kind；旧向量缺字段时按 `normal`。 */
  kind?: EscalationKind;
  /** 谁在仲裁：user=经典可答卡；ceo=协调模式等主管。旧向量缺字段按 user。 */
  awaiting?: "user" | "ceo";
  /** 裁决方：user=用户直答；ceo=主管仲裁。旧向量缺字段按 user。 */
  arbitrated_by?: "user" | "ceo";
  /** 仅 arbitrated_by=ceo：是否经 ask_user 转交用户。 */
  via_user?: boolean;
}

/** One node in the team graph (mirrors desktop RunNode — stores/execution.ts). The
 * tree is encoded by `parentRunId`; `usage`/`cost` ride verbatim from run_completed. */
export interface ProjectedRun {
  id: string;
  agentId: string;
  task: string;
  status: RunStatus;
  dependsOn: string[];
  /** The worker's authored 结论 (`debrief.summary`) or "" — a scan line, not a truncation;
   * null until run_completed folds in. */
  outputSummary: string | null;
  /** 完工交接简报: the worker's structured wrap-up (结论/关键要点/关键假设/建议下一步), set by
   * run_completed when it authored one; null otherwise (辩手 / trivial worker / captain). */
  debrief: RunDebrief | null;
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
  /** 同人续派 / 热修 / 辩论续写：现场根 run id（星型）；null = 冷开局. */
  continuesRunId: string | null;
  /**「计划已调整」轻痕迹 (设计 §7.2): set by `plan_revised` to "bind" (a late-bound
   * placeholder finalised from upstream evidence) or "steer" (a not-yet-run node re-steered
   * after a scope deviation) when the CEO autonomously adjusted this paused node mid-flight;
   * null otherwise. Drives the node's non-interrupting trace label; bind wins over steer. */
  revised: PlanRevisionKind | null;
  /** 回落换人：接手的原 run id；null = 普通委派。 */
  replacesRunId: string | null;
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
  /** Per-run 思考·正文·工具 timeline (对称 CEO ``process``). Empty until deltas/tools fold. */
  process: ProcessStep[];
}

/** 团队便签墙 (§2.2 通): one note a worker broadcast to its CONCURRENT siblings (`team_note_posted`),
 * folded onto the turn for the team-notes panel. `kind` is `decision` (我定了 — others depend on it:
 * an interface / field name / format / naming), `heads_up` (提个醒 — a pitfall / discovery), or
 * `claim` (我领了 — a piece of work / file this worker is taking, so siblings don't duplicate it);
 * `runId` / `agentId` / `role` are the author (谁贴的); `ts` is epoch seconds. `noteId` is the stable
 * key (dedup). Carried in post order.
 *
 * 便签会过期 → supersession (§2.2): `status` is the lifecycle — `active`, or `superseded` (改写: a
 * later note replaced it) / `voided` (作废: retracted). `supersedes` is set only on an amendment
 * note (the `noteId` it 改写/作废s, else `null`), so the panel can strike a stale note and link an
 * amendment to its origin. */
export interface ProjectedTeamNote {
  noteId: string;
  runId: string;
  agentId: string;
  role: string;
  kind: string;
  text: string;
  ts: number | null;
  status: "active" | "superseded" | "voided";
  supersedes: string | null;
  /** `ceo` when seeded by the host before workers run; `inherited` when replayed from a parent run. */
  source?: "ceo" | "worker" | "inherited";
}

/** Mid-flight user interjection into a live coordination turn (`user_interjection`).
 * Same `interjectionId` keeps latest `status` (delivered → queued). */
export interface ProjectedUserInterjection {
  interjectionId: string;
  executionId: string;
  content: string;
  status: "delivered" | "queued" | string;
  note: string | null;
}

/** Interaction lifecycle status in the projected turn (提问确认统一重构 P3). */
export type InteractionStatus = "pending" | "resolved" | "orphaned";

/** Kinds that pause the turn when status=pending (gate surface). */
export const GATE_INTERACTION_KINDS = [
  "approval",
  "ask_user",
  "plan_review",
  "team_preview",
  "delegation_authorization",
] as const;

/** One user-facing interaction across its lifecycle — replaces the old single-slot
 * `pendingInteraction`. All 8 kinds appear; status tracks pending|resolved|orphaned so
 * reload after settle never re-renders a false pending card. Multi-approval concurrency
 * is first-class (array, not last-write-wins). */
export type ProjectedInteraction =
  | {
      kind: "approval";
      id: string;
      status: InteractionStatus;
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      kind: "ask_user";
      id: string;
      status: InteractionStatus;
      question: string;
      context: string;
    }
  | {
      kind: "plan_review";
      id: string;
      status: InteractionStatus;
      runIds: string[];
    }
  | {
      kind: "team_preview";
      id: string;
      status: InteractionStatus;
      workerIds: string[];
    }
  | {
      kind: "delegation_authorization";
      id: string;
      status: InteractionStatus;
      executionId: string;
      workers: Array<Record<string, unknown>>;
      /** Wire field `tools` (not grantable_tools). */
      tools: string[];
    }
  | {
      kind: "escalation";
      id: string;
      status: InteractionStatus;
      runId: string;
      agentId: string;
      question: string;
      assumption: string;
      awaiting?: "user" | "ceo";
    }
  | {
      kind: "question_posted";
      id: string;
      status: InteractionStatus;
      question: string;
      context: string;
    };

/** @deprecated Use {@link ProjectedInteraction}; kept as alias during P3 migration. */
export type PendingInteraction = Extract<
  ProjectedInteraction,
  { status: "pending" }
>;

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
  /** Full interaction inventory (8 kinds × pending|resolved|orphaned). Replaces the
   * legacy single-slot `pendingInteraction` (P3 breaking). */
  interactions: ProjectedInteraction[];
  /** Turn total from message_end.cost (回合总账); null until the turn ends or when no
   * turn ran (error/not-found paths). */
  cost: CostBreakdown | null;
  /** The structured product of a 辩论 that concluded this turn (the `debate_result`
   * event), carried VERBATIM (snake_case kept) — the decision brief + clash
   * narrative the debate view renders, keyed to the graph's debater runs by
   * `run_id`. Null for a turn that ran no debate. */
  debate: DebateResultPayload | null;
  /** 辩论进行中的逐轮叙事（`debate_round_started` / `debate_round` 折叠累积）：让前端进行中
   * 就叠出主持人逐轮焦点 / 小结 / 裁判，而非干等 {@link debate} 收场。P2 DURABLE——落 journal，
   * 刷新后 hydrate/fold 重建；收场后全量叙事线亦在 {@link debate}。非辩论恒 `[]`。 */
  debateRounds: DebateNarrativeRound[];
  /** 本场是否开启质询（`debate_round_started.cross_exam_enabled`）：首轮开场即达。缺字段 /
   * 老 journal → `false`（UI 回退「正在小结…」）。 */
  crossExamEnabled: boolean;
  /** 主持人开场白（`debate_round_started.opening`）：仅首轮携带；sticky 取第一个非空，不被后续
   * 覆盖。收场 {@link debate}.opening 仍是权威。缺字段 / 老 journal → `null`。 */
  debateOpening: string | null;
  /** 协调模式团队进展预览（`team_synthesis_preview`，同 key 保最新）：P2 DURABLE。null 当无。 */
  teamSynthesisPreview: TeamSynthesisPreviewPayload | null;
  /** 预检警告（`turn_warning`）：P2 DURABLE；刷新后横幅重建。null 当无。 */
  turnWarning: string | null;
  /** 团队便签墙 (§2.2 通): the notes workers broadcast to their siblings this turn (`team_note_posted`),
   * in post order. Journaled, so it replays on reload. Empty for a turn with no team notes. */
  teamNotes: ProjectedTeamNote[];
  /** 协调中用户插话（`user_interjection`，同 interjectionId 保最新 status）。Empty when none. */
  userInterjections: ProjectedUserInterjection[];
}
