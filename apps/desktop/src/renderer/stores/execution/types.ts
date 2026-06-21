import type {
  CheckpointDecision,
  ContextBlockWire,
  CostBreakdown,
  DebateNarrativeRound,
  DebateResultPayload,
  RunKind,
  SSEEvent,
  Stance,
  ToolDisplay,
  UsageBreakdown,
} from "@/types/events";

// Re-exported so run-detail components render the「收到的上下文」blocks from the store's
// contract (上下文传递可视化) without reaching into the wire types directly.
export type { ContextBlockWire } from "@/types/events";

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

/** Display labels for a 辩论/审查 side (前端UX设计.md §四) — the single source the
 * graph node badge and the strip title share, so正/反 read consistently. */
export const STANCE_META: Record<Stance, { label: string; short: string }> = {
  pro: { label: "正方", short: "正" },
  con: { label: "反方", short: "反" },
};

/** Tool name → 中文 label, shared by the team graph's live「正在生成」progress line
 * (AgentNode) and the run-detail tool rows. A label-only twin of MessageBubble's
 * TOOL_META (which also couples a lucide icon, so it can't live in the store); keep
 * the two in sync. An unknown tool falls back to its raw name. */
export const TOOL_LABELS: Record<string, string> = {
  web_search: "搜索网页",
  read_url: "读取网页",
  grep: "检索代码",
  code_execute: "执行代码",
  file_read: "读取文件",
  file_write: "写入文件",
  file_list: "列出目录",
  str_replace: "编辑文件",
  file_delete: "删除文件",
  file_move: "移动文件",
  // CEO captain tools (surfaced by the bubble's tool_progress / process timeline).
  delegate: "委派任务",
  ask_user: "向你确认",
  consult_skill: "查阅能力",
  revise: "修订产物",
  // Worker-only upward channel (build_worker_registry); surfaces in run detail.
  escalate: "上报问题",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

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
  /** Rich rendering data resolved on `tool_use_end` (工具结果富渲染); absent for
   * tools whose text `result` is enough. */
  display?: ToolDisplay | null;
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
  /** The tool call this worker is *currently composing* (run_tool_progress): its
   * name + the chars of arguments streamed so far. Non-null only during active
   * argument assembly — set on each progress tick, cleared once the call starts
   * executing (tool_use_start) or the run ends. Drives the node/detail's live
   *「正在生成 {tool} · N 字」line so a long file write never looks frozen. */
  toolProgress: { toolName: string; chars: number } | null;
}

/** A structured DAG checkpoint (plan_review, 结构化挂起 2a) that paused the scheduler
 * *after* a run completed and *before* its dependents ran. `decision` is null while
 * the user has not answered; on resolve it records 继续/停止 (`continue`/`stop`; an
 * engine timeout folds in as `timeout`). Drives the node's pause badge. */
export interface RunCheckpoint {
  status: "pending" | "resolved";
  decision: CheckpointDecision | null;
}

/** 升级实时可见 / 阻塞式求决策: one escalation a worker raised mid-run via `escalate` (its
 * only upward channel to the CEO). `question` is the self-contained ask; `assumption` is what
 * the worker proceeds on; `blocking` flags that a wrong guess would void its product. Folded
 * onto its {@link RunNode} so the node shows a ⚠️ badge and the card raises a turn-level notice
 * the moment it fires — not after the CEO synthesizes.
 *
 * `status` is the lifecycle: `raised` = a non-blocking `run_escalation` banner (the worker kept
 * working); `pending` = a blocking `escalation_required` parked on the user (the card is live);
 * `resolved` = the user answered (`answer` carries it); `timeout` = no answer / 按假设继续 (the
 * worker fell back to its `assumption`). A blocking escalation folds `escalation_required`→
 * `pending`, then its `escalation_resolved`→`resolved`/`timeout`. `answer` is the user's reply
 * when resolved, `null` otherwise. Mirrors the conformance `RunEscalation` (golden-pinned). */
export interface RunEscalation {
  /** 阻塞式求决策: the `escalation_id` (interaction id) of a BLOCKING escalation — the key the
   * `EscalationCard` POSTs the user's answer to (`POST …/interactions/{id}`). Set from
   * `escalation_required`; `null` for a non-blocking `raised` banner (no resolve target).
   * Desktop-local — STRIPPED from the conformance `ProjectedTurn` (the golden never carries it),
   * so threading it here does not widen the cross-end contract. */
  id: string | null;
  question: string;
  assumption: string;
  blocking: boolean;
  status: "raised" | "pending" | "resolved" | "timeout";
  answer: string | null;
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
  /** 辩论/审查 呈现标记 (前端UX设计.md §四, display-only): this run's side in an
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
  /** 收到的上下文 (上下文传递可视化): the structured ContextBlocks this run was fed at
   * assembly time, from its `run_context` frame — the SAME data the LLM saw (原始请求 /
   * 团队位置 / 前置结果 / 工作区 / 任务…). Empty until that frame folds in (or for a run
   * whose opening wasn't block-assembled). Drives the run detail's「收到的上下文」area. */
  receivedContext: ContextBlockWire[];
  /** 升级实时可见: escalations this run raised via `escalate`, in fire order. Empty for
   * the common case; non-empty drives the node's ⚠️ badge + the card's live notice.
   * Appended on each `run_escalation` frame. */
  escalations: RunEscalation[];
}

export interface Execution {
  id: string;
  planType: "single_agent" | "multi_agent" | "debate";
  taskSummary: string;
  status: ExecutionStatus;
  agents: AgentState[];
  runs: RunNode[];
  progress: { completed: number; total: number };
  /** 辩论收场产物（`debate_result`）：决策简报 + 交锋叙事线，verbatim 承载；null = 非
   * 辩论回合。与 {@link runs} 互补——辩手发言全文在对应辩手节点，本字段是主持人的逐轮
   * 裁判/小结 + 决策简报（{@link DebateView} 据此渲染）。 */
  debate: DebateResultPayload | null;
  /** 辩论进行中的逐轮叙事（`debate_round_started` / `debate_round` 折叠累积）：让进行中就叠
   * 出主持人逐轮焦点 / 小结 / 裁判，而非干等 {@link debate} 收场。Transport-only 事件，重载
   * （journal 无逐轮事件）恒为 `[]`——届时全量叙事线已在 {@link debate}。非辩论恒 `[]`。 */
  debateRounds: DebateNarrativeRound[];
}

/**
 * Immutable skeleton declared once when the DAG is planned (`run_plan`).
 * Frames mutate a *projection* of this skeleton — never the skeleton itself.
 */
export interface ExecutionPlan {
  id: string;
  planType: "single_agent" | "multi_agent" | "debate";
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
    /** 辩论/审查 呈现标记 (前端UX设计.md §四, display-only): opposing-side tag,
     * pairing group, and 真·多轮辩论 turn (`round`). Declared at plan time so the
     * strip can show a「辩论」title and the graph can band正/反 + 逐轮 from the plan
     * alone, before any run frame folds in. */
    stance?: Stance;
    group?: string;
    round?: number;
  }[];
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
