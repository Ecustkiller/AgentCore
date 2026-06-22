// SSE event contract — shared source for desktop + mobile folds (前端技术与架构 §十二).
// Event names: generated from backend EventType (`eventTypes.generated.ts`).
// Payload shapes: hand-maintained here until a richer codegen lands.

import type { SSEEventType } from "./eventTypes.generated";

export type { SSEEventType } from "./eventTypes.generated";

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  timestamp: string;
  payload: T;
}

export interface MessageStartPayload {
  message_id: string;
  conversation_id: string;
  /** The turn's log correlation id (trace_id, 32-hex), stamped so the client can surface
   * it for one-step log lookup (复制 trace id → grep trace_id=...). Omitted when the turn
   * ran without a trace context (e.g. conformance vectors built outside a turn). */
  trace_id?: string;
}

export interface ContentDeltaPayload {
  delta: string;
}

/** 交付前核验回炉（finish_guard）：CEO 自报 done 的正文未过轻层核验（如编造引用），引擎丢弃
 * 这一版、回炉重写。Payload-less 信号——客户端清空当前流式气泡已累积的正文（含 process 尾部
 * content 步），再接收重写版的 `content_delta`，使「违规版 → 修正版」是一次干净替换而非追加。
 * Transport-only（不进 journal；历史回放靠最终 message content / 持久化的 process timeline）。 */
export type ContentResetPayload = Record<string, never>;

export interface ReasoningDeltaPayload {
  delta: string;
}

/** The CEO captain is composing a tool call's ARGUMENTS (bubble-scoped twin of
 * `RunToolProgressPayload`). Transport-only liveliness: never journaled. */
export interface ToolProgressPayload {
  tool_name: string;
  chars: number;
}

export interface ToolUseStartPayload {
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  /** Present (run id) when a DELEGATED WORKER raised this call — workers share the
   * turn's top-level tool_use stream with the captain. Process folds (the captain
   * bubble's inline timeline) skip a tagged call: it belongs to that worker's run
   * node, not the CEO's timeline (统一团队时间线 = the CEO's OWN steps). Absent for the
   * captain's own calls. */
  run_id?: string;
}

/** A tool's OPTIONAL render-oriented payload (工具结果富渲染), distinct from the
 * model-facing `result` text. Opaque on the wire (snake_case). */
export type ToolDisplay = Record<string, unknown>;

export interface ToolUseEndPayload {
  tool_call_id: string;
  tool_name: string;
  result: string;
  status: "success" | "error";
  display?: ToolDisplay | null;
  /** Worker-call tag; see {@link ToolUseStartPayload.run_id}. Absent for the
   * captain's own calls. */
  run_id?: string;
}

/** One step in a single-agent turn's 思考·正文·工具 inline timeline (前端UX设计.md
 * §一B). A `reasoning` step coalesces consecutive thinking deltas, a `content` step
 * coalesces consecutive reply-text deltas, and a `tool` step records one call
 * resolved by its matching `tool_use_end`. */
export type ProcessStep =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | {
      kind: "tool";
      id: string;
      tool_name: string;
      arguments: Record<string, unknown>;
      result: string | null;
      status: "running" | "success" | "error";
      display?: ToolDisplay | null;
    };

/** The user's settlement of a paused GRANTABLE tool call; mirrors the backend
 * `ApprovalDecision`. */
export type ApprovalDecision =
  | "approve"
  | "approve_always"
  | "approve_always_files"
  | "deny";

export interface ApprovalRequiredPayload {
  approval_id: string;
  conversation_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ApprovalResolvedPayload {
  approval_id: string;
  tool_call_id: string;
  decision: ApprovalDecision;
}

/** The user's settlement of a checkpoint the CEO raised (ask_user). */
export type CheckpointDecision = "continue" | "adjust" | "stop" | "timeout";

export interface AskAssumption {
  id: string;
  label: string;
  value: string;
}

export interface AskQuestion {
  id: string;
  prompt: string;
  kind: "choice" | "text";
  options: string[];
  multiple: boolean;
  default: string;
}

export interface AskStyleOption {
  id: string;
  label: string;
}

export interface CheckpointRequiredPayload {
  checkpoint_id: string;
  conversation_id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  style_options: AskStyleOption[];
}

export interface CheckpointResolvedPayload {
  checkpoint_id: string;
  decision: CheckpointDecision;
  note: string;
  selected?: string[];
}

/** A non-blocking ask the CEO posted (ask_user blocking=false): surfaced a question
 * it already has a default for and KEPT WORKING — no suspend, no resolve. */
export interface QuestionPostedPayload {
  ask_id: string;
  conversation_id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  style_options: AskStyleOption[];
}

export interface PlanReviewStep {
  run_id: string;
  role: string;
  summary: string;
}

export interface PlanReviewPending {
  run_id: string;
  role: string;
}

export interface PlanReviewRequiredPayload {
  checkpoint_id: string;
  conversation_id: string;
  steps: PlanReviewStep[];
  pending: PlanReviewPending[];
}

export interface PlanReviewResolvedPayload {
  checkpoint_id: string;
  decision: CheckpointDecision;
  note: string;
}

/** How the CEO autonomously adjusted a paused plan node (受监督的波循环, 设计 §7.2):
 * `bind` = a late-bound placeholder (`bind_after_deps`) finalised from upstream evidence;
 * `steer` = a not-yet-run node re-steered after a 队员 scope deviation. Drives the node's
 *「计划已调整」trace label. */
export type PlanRevisionKind = "bind" | "steer";

/** One node the CEO re-bound / re-steered in a single `replan` (设计 §7.2). */
export interface PlanRevision {
  run_id: string;
  kind: PlanRevisionKind;
}

/** 自主再绑定「计划已调整」轻痕迹 (设计 §7.2): the CEO adjusted a paused delegate plan via
 * `replan` — finalising late-bound placeholders and/or re-steering not-yet-run nodes from
 * mid-flight evidence (no user interruption). `revisions` names the affected graph nodes +
 * how each changed; every end folds it onto those nodes as a non-interrupting trace. Emitted
 * ONLY when something changed (a no-op resume sends nothing). Journaled, so it replays on
 * reload. Always co-occurs with `run_plan` in a delegate turn. */
export interface PlanRevisedPayload {
  execution_id: string;
  revisions: PlanRevision[];
}

export interface PlanAgentPayload {
  id: string;
  role: string;
  model_preference: "fast" | "strong";
  thinking: boolean;
  reasoning_effort: "high" | "max" | null;
}

export interface RunPlanPayload {
  execution_id: string;
  /** `debate` is a 辩论编排 surface (debate 工具/主持人): the moderator + per-round
   * debater nodes are declared as run_plan batches just like multi_agent, plus a
   * terminal `debate_result` carrying the brief + narrative. The graph folds the
   * nodes identically; the debate view keys off this plan_type. */
  plan_type: "single_agent" | "multi_agent" | "debate";
  task_summary: string;
  agents: PlanAgentPayload[];
  runs: Array<{
    id: string;
    agent_id: string;
    task: string;
    depends_on: string[];
    parent_run_id?: string | null;
    kind?: RunKind;
    stance?: Stance;
    group?: string;
    round?: number;
  }>;
}

/** What a run node *is*: the CEO chat loop is the turn's `captain` root, a delegated
 * / DAG worker is an `agent`. Mirrors the backend `RunKind` enum. */
export type RunKind = "agent" | "captain";

/** A 辩论/审查 node's side (display-only): the CEO sets it via delegate's `stance`. */
export type Stance = "pro" | "con";

export interface RunStartedPayload {
  run_id: string;
  agent_id: string;
  parent_run_id: string | null;
  kind: RunKind;
  revision?: number;
}

/** One labeled segment of context a run received at assembly time (上下文传递可视化) —
 * the wire twin of the backend `ContextBlock`, and the structured single source behind
 * both the prompt and this event (用户看到的 == LLM 吃到的). `channel` buckets it for the
 * UI. Worker 侧: `request` (团队级原始请求) / `team_position` (DAG 拓扑) / `dependency` (上游
 * 产物注入) / `workspace` (工作区文件清单) / `task` / `expected_output` / `requirements` /
 * `steer`. CEO (captain) 侧 通道①: `system` (本回合系统提示，决策②默认隐藏) / `history` (本
 * 回合之前的往来) — these ride the turn-level `captainContext`, never a graph node. A
 * `dependency` block carries its provenance — the upstream `source_role` / `source_run_id`,
 * the `fidelity` chosen (`pointer` 递指针 / `summarize` / `pass_through`), and the artifact
 * `files` it points at. `chars` is the ORIGINAL injected size; `truncated` flags that `body`
 * was capped (budget trim OR the event's display cap). */
export interface ContextBlockWire {
  // CEO-side channels: `system`/`history`/`request` (opening, 通道①) and `team_result`
  // (each delegated worker's product folded back to the CEO after a batch, 通道⑤ — carries
  // `source_role`/`fidelity` provenance). The rest are worker-side (通道②–④).
  channel:
    | "system"
    | "history"
    | "request"
    | "team_position"
    | "dependency"
    | "workspace"
    | "task"
    | "expected_output"
    | "requirements"
    | "steer"
    | "team_result";
  heading: string;
  body: string;
  chars: number;
  truncated: boolean;
  source_role: string;
  source_run_id: string;
  fidelity: "" | "pointer" | "summarize" | "pass_through";
  files: string[];
}

/** The structured context a run was fed (上下文传递可视化), emitted once right after
 * `run_started`. `blocks` is the ordered list the opening was assembled from, so the UI
 * shows exactly what fed the LLM. A WORKER's blocks fold onto its graph node
 * (`receivedContext`); the CEO CAPTAIN's (`run_started` kind=`captain`) fold turn-level
 * onto `captainContext` — the captain is the bubble above the graph, not a peer node, so
 * its context shows on every turn (pure chat included), not only when it delegates.
 * Journaled, so a past turn replays its received context on reload through the same fold. */
export interface RunContextPayload {
  run_id: string;
  agent_id: string;
  blocks: ContextBlockWire[];
}

export interface RunOutputDeltaPayload {
  run_id: string;
  agent_id: string;
  delta: string;
}

export interface RunReasoningDeltaPayload {
  run_id: string;
  agent_id: string;
  delta: string;
}

export interface RunToolProgressPayload {
  run_id: string;
  agent_id: string;
  tool_name: string;
  chars: number;
}

/** 升级实时可见: a delegated worker raised `escalate` — surfaced live at the call
 * instant (run-scoped) so the team UI shows「⚠️ 上报」on that worker's node + a
 * turn-level notice, instead of the signal staying buried in the worker's process
 * timeline or only reaching the user folded into the CEO's reply. `question` is the
 * worker's self-contained ask for the CEO; `assumption` is what it proceeds on
 * meanwhile (escalate 非阻塞 — the worker keeps working); `blocking` flags severity
 * (a wrong guess would void its product). Transport-only liveliness: NOT journaled —
 * the durable record is the run's escalations (harvested into CEO synthesis), so a
 * reload rebuilds it from the journal, not from this event. */
export interface RunEscalationPayload {
  run_id: string;
  agent_id: string;
  question: string;
  assumption: string;
  blocking: boolean;
}

/** 阻塞式求决策 (escalate blocking=true): a delegated worker SUSPENDED itself on a
 * 「只有用户能定、且猜错就作废」fork and is awaiting the user's call — the CEO is parked at
 * its `delegate` mid-wave, so the worker asks the user DIRECTLY. This surfaces the interactive
 * decision card (`EscalationCard`), keyed by `escalation_id` for the resolve endpoint. `question`
 * is the worker's self-contained ask; `assumption` is the fallback it proceeds on if no answer
 * arrives (the timeout degrade). Run-scoped so the card attaches to this worker's node. UNLIKE
 * the (transport-only) non-blocking `run_escalation` banner, this is JOURNALED — the prompt + its
 * resolution replay inline on reload, and the turn never flips to `paused` (siblings keep
 * running). 设计: docs/07-规划/阻塞式求决策设计.md §4.2/§4.5. */
export interface EscalationRequiredPayload {
  escalation_id: string;
  run_id: string;
  agent_id: string;
  question: string;
  assumption: string;
}

/** 阻塞式求决策 settlement (设计 §4.4): a blocking escalate resolved and the worker resumes.
 * `status` is `"resolved"` (the user answered — `answer` carries it, fed back into the worker's
 * loop with「以用户答复为准，回改与假设冲突的已做部分」) or `"timeout"` (no answer within the
 * window, or the user chose 按假设继续 — the worker falls back to its stated assumption, i.e.
 * degrades to today's non-blocking behaviour; `answer` empty). Emitted by the suspending tool's
 * awaiter ONLY (单一发射者: never by the resolve route), so the event always matches what the
 * worker actually did. Journaled as the twin of `escalation_required` so the exchange replays
 * inline on reload. */
export interface EscalationResolvedPayload {
  escalation_id: string;
  run_id: string;
  agent_id: string;
  status: "resolved" | "timeout";
  answer: string;
}

/** Token counts in the ledger short-key form. `cache_hit + cache_miss === input`;
 * `reasoning ⊆ output`. */
export interface UsageBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache_hit: number;
  cache_miss: number;
}

/** A run's / turn's cost in integer nano-USD (1 USD = 1e9). `total === input +
 * output`; all-zero means "no metered cost". */
export interface CostBreakdown {
  input: number;
  cached: number;
  output: number;
  total: number;
  currency: string;
}

export interface RunCompletedPayload {
  run_id: string;
  agent_id: string;
  output_summary: string;
  duration_ms: number;
  role: string;
  model: string;
  usage: UsageBreakdown;
  cost: CostBreakdown;
}

export interface RunFailedPayload {
  run_id: string;
  agent_id: string;
  error: string;
}

export interface RunProgressPayload {
  completed: number;
  total: number;
}

// ── 辩论编排产物（debate 工具/主持人收场，前端辩论视图渲染用）─────────────────
// 一场辩论收场时 emit 的【完整结构化产物】，与 run_plan(plan_type="debate") 的图节点
// 互补：图承载逐辩手执行（发言全文随辩手 run 走 run_output_delta），本事件承载主持人的
// 交锋叙事线（逐轮焦点/裁判/小结）+ 决策简报。各方发言全文不在此（体量大），靠
// `rounds[*].sides[*].run_id` 关联执行图的辩手节点取回。Snake_case 原样（wire-shaped
// leaf，三端 verbatim 折入 ProjectedTurn.debate，不做有损转换）。

/** 一方/一个视角的定义（决策简报与叙事线据此标注立场）。`stance` 是自由文本（debate
 * 为 支持/反对，red_team 为 红队/被审方，roundtable 为各视角名），区别于图节点 badge
 * 用的 `Stance`（仅 pro/con）。`is_subject` 标红队被审的方案方。 */
export interface DebateSideInfo {
  key: string;
  name: string;
  stance: string;
  is_subject: boolean;
}

/** 叙事线某一轮里某一方的执行指针：`run_id` 关联执行图的辩手节点（取发言全文 L3）。 */
export interface DebateRoundSide {
  key: string;
  name: string;
  run_id: string;
  ok: boolean;
}

/** 主持人对一轮交锋的裁判（收敛判定 L1）：是否真交锋/有新论据/已收敛 + 停轮理由。 */
export interface DebateVerdict {
  real_clash: boolean;
  new_arguments: boolean;
  converged: boolean;
  stop_reason: string;
  rationale: string;
}

/** 论点级交锋边（L3 谁驳谁）：`from_key` 一方针对性反驳了 `to_key` 一方，`point` 是反驳要点
 * （一句话）。`from_key`/`to_key` 是 {@link DebateSideInfo.key}（语义键，非 run_id）。主持人裁判
 * 步逐轮抽取（仅真正针锋相对的、≤4 条），让前端把「各说各话」升级为可读的交锋关系。 */
export interface DebateClash {
  from_key: string;
  to_key: string;
  point: string;
}

/** 叙事线的一轮（L1 焦点 + 裁判 / L2 小结 / L3 交锋边）：`sides` 是本轮各方→辩手 run 的映射，
 * `clashes` 是本轮论点级谁驳谁。 */
export interface DebateRoundInfo {
  round_no: number;
  focus: string;
  summary: string;
  verdict: DebateVerdict;
  sides: DebateRoundSide[];
  clashes: DebateClash[];
}

/** 进行中实时叠加的一轮叙事态（debate_round_started / debate_round 折叠累积，进 ProjectedTurn
 * .debateRounds）：`debate_round_started` 先给 `focus`（`verdict=null` ⇒ 该轮只定了焦点、尚未
 * 裁判，即进行中，`clashes` 恒空），`debate_round` 补 `summary`/`verdict`/`sides`/`clashes`。收场后
 * 由 `debate_result` 的全量 `rounds`（{@link DebateRoundInfo}，`verdict` 必有）接管——本类型是
 * 「进行中」的孪生。 */
export interface DebateNarrativeRound {
  round_no: number;
  focus: string;
  summary: string;
  verdict: DebateVerdict | null;
  sides: DebateRoundSide[];
  clashes: DebateClash[];
}

/** 决策简报（结论卡）：交锋焦点、各方最强论点、事实/价值分歧、倾向与置信、建议、待解问题。 */
export interface DebateBriefInfo {
  crux: string;
  strongest_points: Record<string, string>;
  factual_disputes: string[];
  value_disputes: string[];
  leaning: string;
  confidence: string;
  recommendation: string;
  open_questions: string[];
}

export interface DebateResultPayload {
  execution_id: string;
  /** 主持人节点的 run_id（前端据此把本事件挂到对应辩论上）。 */
  moderator_run_id: string;
  form: "debate" | "red_team" | "roundtable";
  motion: string;
  /** 收场原因（converged / focus_clarified / red_team_exhausted / max_rounds / all_failed）。 */
  stop_reason: string;
  /** 呈现顺序提示：true=叙事线优先（如 roundtable 探讨），false=简报优先（如 debate 决策）。 */
  narrative_first: boolean;
  sides: DebateSideInfo[];
  rounds: DebateRoundInfo[];
  brief: DebateBriefInfo;
}

/** 一轮辩论开场（辩手发言【前】）：主持人定下本轮焦点 → 前端先亮焦点头、再流式各方发言。
 * Transport-only（不进 journal）；收场全量叙事线由 {@link DebateResultPayload} 承载。 */
export interface DebateRoundStartedPayload {
  execution_id: string;
  moderator_run_id: string;
  round_no: number;
  focus: string;
}

/** 一轮辩论收尾（裁判 + 小结【后】）：即 {@link DebateResultPayload.rounds} 的逐轮单元，加
 * 上 `execution_id`/`moderator_run_id` 定位。前端进行中据此叠本轮焦点 / 小结 / 裁判到辩论视图。
 * Transport-only（不进 journal，重载由 `debate_result` 重建）。 */
export interface DebateRoundPayload extends DebateRoundInfo {
  execution_id: string;
  moderator_run_id: string;
}

export interface MessageEndPayload {
  finish_reason:
    | "end_turn"
    | "max_rounds"
    | "degraded"
    | "unproductive"
    | "error"
    | "cancelled";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
  };
  cost?: CostBreakdown | null;
  rounds?: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface TitleGeneratedPayload {
  conversation_id: string;
  title: string;
}

export interface TurnSavedPayload {
  user_message_id: string;
}

export interface Citation {
  url: string;
  title: string;
  snippet?: string;
  site?: string;
}

export interface CitationsPayload {
  citations: Citation[];
}

export interface WorkspaceOpRequiredPayload {
  request_id: string;
  conversation_id: string;
  root_id: string;
  op: string;
  args: Record<string, unknown>;
}

/** A folderless 裸聊 was lazily promoted into a real folder on its first file write
 * (文件夹即工作区 §懒建 / 工作区对称化 D1a). The chat now belongs to `folder_id`; the
 * live client re-groups it under that folder and surfaces the new workspace in the 文件
 * rail — without this the promotion is invisible until a manual refetch/reload. A local
 * promotion carries `local_root_id` + `local_subpath` (the file landed on the user's
 * machine); a cloud one leaves `local_root_id` null. One-shot signal — the folder is
 * durable state read back on reload, so it is not journaled. */
export interface WorkspacePromotedPayload {
  conversation_id: string;
  folder_id: string;
  name: string;
  local_root_id: string | null;
  local_subpath: string;
}

export interface HandoffSnapshotDonePayload {
  snapshot_id: string;
  conversation_id: string;
  size_bytes: number;
}

export interface HandoffJobStartedPayload {
  job_id: string;
  conversation_id: string;
  job_conversation_id: string;
}

export interface HandoffApplyResult {
  path: string;
  status: "applied" | "skipped" | "conflict" | "error";
  change_type: "added" | "modified" | "deleted" | null;
  detail: string;
}

export interface HandoffApplyDonePayload {
  job_id: string;
  conversation_id: string;
  results: HandoffApplyResult[];
  applied: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

export type SSEPayloadMap = {
  message_start: MessageStartPayload;
  content_delta: ContentDeltaPayload;
  content_reset: ContentResetPayload;
  reasoning_delta: ReasoningDeltaPayload;
  tool_progress: ToolProgressPayload;
  tool_use_start: ToolUseStartPayload;
  tool_use_end: ToolUseEndPayload;
  approval_required: ApprovalRequiredPayload;
  approval_resolved: ApprovalResolvedPayload;
  checkpoint_required: CheckpointRequiredPayload;
  checkpoint_resolved: CheckpointResolvedPayload;
  question_posted: QuestionPostedPayload;
  plan_review_required: PlanReviewRequiredPayload;
  plan_review_resolved: PlanReviewResolvedPayload;
  plan_revised: PlanRevisedPayload;
  run_plan: RunPlanPayload;
  run_started: RunStartedPayload;
  run_context: RunContextPayload;
  run_output_delta: RunOutputDeltaPayload;
  run_reasoning_delta: RunReasoningDeltaPayload;
  run_tool_progress: RunToolProgressPayload;
  run_completed: RunCompletedPayload;
  run_failed: RunFailedPayload;
  run_progress: RunProgressPayload;
  run_escalation: RunEscalationPayload;
  escalation_required: EscalationRequiredPayload;
  escalation_resolved: EscalationResolvedPayload;
  debate_result: DebateResultPayload;
  debate_round_started: DebateRoundStartedPayload;
  debate_round: DebateRoundPayload;
  message_end: MessageEndPayload;
  error: ErrorPayload;
  title_generated: TitleGeneratedPayload;
  turn_saved: TurnSavedPayload;
  citations: CitationsPayload;
  workspace_op_required: WorkspaceOpRequiredPayload;
  workspace_promoted: WorkspacePromotedPayload;
  handoff_snapshot_done: HandoffSnapshotDonePayload;
  handoff_job_started: HandoffJobStartedPayload;
  handoff_apply_done: HandoffApplyDonePayload;
};
