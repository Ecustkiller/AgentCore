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

/** A running tool's coarse EXECUTION phase (工具执行阶段进度) — surfaced live so a blocking
 * tool's waiting row is honest instead of a dead spinner. Known values:
 * - web_search: `queued` (排队中 — gated by the rate/concurrency limiter under a parallel-team
 *   burst), `querying` (正在检索 — the engine request is in flight), `fallback` (改用备用引擎 —
 *   the primary went search-blind, retrying via Tavily).
 * - read_url: `fetching` (正在抓取网页 — the GET is in flight), `reading` (正在提取正文 — parsing
 *   the fetched HTML), `blocked` (出网受限 — this host's egress circuit is OPEN so the read
 *   fast-fails; read_url has no queue, so it has no `queued` state, only this honest block).
 * - code_execute: `executing` (正在执行 — the sandbox run is in flight).
 * Kept as a widened `string` on the wire so the backend can add phases without a client bump —
 * an unknown value maps to a generic「处理中」. */
export type ToolPhase =
  | "queued"
  | "querying"
  | "fallback"
  | "fetching"
  | "reading"
  | "executing"
  | "blocked";

/** A running tool reported an EXECUTION phase — emitted between `tool_use_start` and
 * `tool_use_end` so the waiting UI shows a live, honest state instead of a bare spinner.
 * Distinct from `tool_progress` (which means the LLM is still streaming this call's
 * ARGUMENTS). Transport-only liveliness: NEVER journaled and NEVER folded into the process
 * timeline / ProjectedTurn — a reloaded turn's tools are already resolved, so it only rides
 * the LIVE stream (the client updates the running tool step's ephemeral `phase`). `run_id`
 * is present for a delegated worker's call (twin of {@link ToolUseStartPayload.run_id}). */
export interface ToolUseProgressPayload {
  tool_call_id: string;
  tool_name: string;
  phase: string;
  run_id?: string;
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

/** One step in a turn's 思考·正文·工具·协作 inline timeline (统一团队时间线,
 * 前端UX设计.md §一B). The first three kinds are the CEO bubble's own narrative:
 * a `reasoning` step coalesces consecutive thinking deltas, a `content` step
 * coalesces consecutive reply-text deltas, and a `tool` step records one call
 * resolved by its matching `tool_use_end`.
 *
 * The remaining kinds are POSITIONAL MARKERS — zero-width anchors that fix WHERE a
 * non-text turn element renders in chronological order, instead of being stamped at
 * the bottom of the bubble. Each carries only the id needed to look its full payload
 * up from the turn's side channels (the team execution / the checkpoint·ask·plan_review
 * folds), so the timeline stays the single ordered source of truth for position:
 * - `team`: the multi-agent collaboration graph slot (emitted at the turn's first
 *   `run_plan`; an orchestration tool — delegate/debate — therefore creates NO tool
 *   step, this marker stands in its place).
 * - `checkpoint`: a blocking `ask_user` checkpoint card (`checkpoint_required`).
 * - `ask`: a non-blocking question card (`question_posted`).
 * - `plan_review`: a plan-review gate card (`plan_review_required`). */
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
      /** 工具执行阶段进度 (联网搜索前端展示优化): the running tool's latest coarse phase from a
       * `tool_use_progress` event (web_search → queued / querying / fallback), driving the
       * waiting-state text. LIVE-ONLY ephemeral: never journaled and never in the backend /
       * conformance ProjectedTurn (the golden's tool steps carry no phase — a reloaded turn's
       * tools are already resolved), so it stays absent under conformance replay and is
       * meaningful only while `status === "running"`. */
      phase?: ToolPhase;
    }
  | { kind: "team"; execution_id: string }
  | { kind: "checkpoint"; checkpoint_id: string }
  | { kind: "ask"; ask_id: string }
  | { kind: "plan_review"; checkpoint_id: string };

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

/** One selectable answer to a choice {@link AskQuestion}. The `label` is both the
 * displayed text and the value composed back into the answer (答复模型 α — there is no
 * separate wire value). `detail` is an optional one-line trade-off shown under the label
 * (帮用户看懂「为什么选它」); `recommended` flags the option the asker (CEO / worker) advises
 * — a purely advisory highlight, NOT a pre-selection (the seeded pick is still driven by
 * the question's `default`). At most one option per question carries `recommended`. */
export interface AskOption {
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface AskQuestion {
  id: string;
  prompt: string;
  kind: "choice" | "text";
  options: AskOption[];
  multiple: boolean;
  default: string;
}

export interface AskStyleOption {
  id: string;
  label: string;
}

export type CheckpointIntent = "kickoff" | "decision";

export interface CheckpointRequiredPayload {
  checkpoint_id: string;
  conversation_id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  style_options: AskStyleOption[];
  intent?: CheckpointIntent;
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
  /** 乙 wire 携 round/stance: a 续写 revision (a debater's later round) carries its
   * debater identity + TRUE round on the wire, so every view derives 第几轮/哪一方 from
   * ONE place instead of re-guessing (round ≠ revision# once a side fails mid-debate).
   * Absent on an ordinary run / hot-fix revision (folds fall back to the original's
   * stance/group + revision-as-round for legacy journals). Mirrors {@link RunPlanPayload}. */
  stance?: Stance;
  group?: string;
  round?: number;
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
  //
  // 续写通道 (continue_run context): a 续写 run (round ≥ 2 / 定向唤回) is fed continuation-scoped
  // context instead of the opening blocks. Debate 逐轮: `round_focus` (本轮焦点) / `opponent`
  // (对方上一轮论点, carries `source_role`/`fidelity` like a dependency) / `challenge` (上一轮被驳
  // 命门) / `interjection` (用户本轮追问) — see debate/prompt.py `round_context_blocks`. 定向唤回热修:
  // `revision` (本次修订要求, the CEO's feedback the recall was fed) — see tools/builtin/revise.py.
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
    | "team_result"
    | "round_focus"
    | "opponent"
    | "challenge"
    | "interjection"
    | "revision"
    | "cross_exam";
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

// 交付前核验回炉时清掉这个 worker 卡片已流式累积的草稿正文（content_reset 的 worker 对偶）。
// transport-only、不进 journal；fold 收到即清该 agent 的 outputChunks，重写版重新流式。
export interface RunOutputResetPayload {
  run_id: string;
  agent_id: string;
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
 * arrives (the timeout degrade). `questions` is the optional structured-fork list (同 ask_user 的
 * questions — choice/text/multiple/default) the card renders so the user one-taps a decision
 * instead of free-typing; empty for a plain free-text ask. Run-scoped so the card attaches to this
 * worker's node. UNLIKE the (transport-only) non-blocking `run_escalation` banner, this is JOURNALED
 * — the prompt (incl. its structured questions) + resolution replay inline on reload, and the turn
 * never flips to `paused` (siblings keep running). 设计: docs/06-规划/阻塞式求决策设计.md §4.2/§4.5. */
export interface EscalationRequiredPayload {
  escalation_id: string;
  run_id: string;
  agent_id: string;
  question: string;
  assumption: string;
  /** Structured forks (同 ask_user 的 questions). Optional: absent on old journaled events
   * (fold with `?? []`) and empty for a free-text ask. Desktop renders these via the shared
   * ask_user question UI; mobile ignores them until its escalation answer card lands. */
  questions?: AskQuestion[];
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

/** 团队便签墙 (§2.2 通·便签墙): a delegated worker pinned a one-line note for its CONCURRENT
 * siblings — `decision` (我定了 X：别人要依赖的接口 / 字段名 / 格式 / 命名), `heads_up`
 * (提个醒 Y：踩到的坑 / 发现), or `claim` (我领了 Z：认领一块活 / 文件，避免和队友撞活 / 重复 —
 * the proactive, visible counterpart of WriteCoordinator's hard file guard). Broadcast
 * fire-and-forget (the poster keeps working, never awaits a reply — it is NOT a chat), and
 * pushed into siblings before their next step so the parallel silos build on each other's
 * evolving work. `note_id` is a stable key (dedup); `run_id` / `agent_id` / `role` are the
 * author (谁贴的); `ts` is epoch seconds. Scoped to one delegate batch (`execution_id`).
 * Journaled, so the team-notes panel replays on reload.
 *
 * 便签会过期 → supersession (§2.2): an AMENDMENT note also carries `supersedes` (the `note_id`
 * it 改写/作废s) + `supersede_mode` (`update` → target superseded / `void` → target voided).
 * Those two are the single signal every fold uses to mark the TARGET stale; a fresh post omits
 * them. */
export interface TeamNotePostedPayload {
  execution_id: string;
  note_id: string;
  run_id: string;
  agent_id: string;
  role: string;
  kind: "decision" | "heads_up" | "claim";
  text: string;
  ts: number;
  /** Set only on an amendment: the `note_id` this note 改写/作废s (its target). Absent on a
   * fresh post. */
  supersedes?: string;
  /** Set only on an amendment: `update` (改写 — target becomes superseded, this note carries the
   * corrected decision) or `void` (作废 — target becomes voided, this note is a retraction). */
  supersede_mode?: "update" | "void";
  /** `ceo` when seeded by the host before workers run; absent or `worker` for worker posts. */
  source?: "ceo" | "worker" | "inherited";
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

/** 完工交接简报 (a worker's structured wrap-up, submitted via its terminal `handoff` tool call
 * and read server-side straight off the call's arguments — never parsed out of prose).
 * Carried VERBATIM on `run_completed` so the run-detail 摘要 renders the author's own
 * conclusion instead of a machine truncation of raw prose. Every field is optional — a worker
 * fills only the sections it has (`summary` 结论 / `key_points` 关键要点 / `assumptions` 关键假设 /
 * `next_steps` 建议下一步); a worker that finished without calling `handoff` (辩手 / trivial
 * worker / the CEO captain) has none, so the whole object is absent
 * (see {@link RunCompletedPayload.debrief}). */
export interface RunDebrief {
  summary?: string;
  key_points?: string[];
  assumptions?: string;
  next_steps?: string;
}

export interface RunCompletedPayload {
  run_id: string;
  agent_id: string;
  /** The worker's authored 结论 (`debrief.summary`), or "" when it wrote none — a
   * best-effort scan line for the whiteboard card / mobile resume, NEVER a truncation of
   * the full deliverable (which is always streamed + persisted + shown in full). */
  output_summary: string;
  duration_ms: number;
  role: string;
  model: string;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  /** 完工交接简报: the worker's structured wrap-up, present ONLY when it authored one
   * (absent for a 辩手 / trivial worker / the captain) so the client folds default it null. */
  debrief?: RunDebrief;
  /** Workspace-relative paths the worker wrote during this run (`files_touched` at finish).
   * Present only when non-empty — lets clients crystallize file artifact cards. */
  output_files?: string[];
}

export interface RunFailedPayload {
  run_id: string;
  agent_id: string;
  error: string;
  /** 完工交接简报: the worker's structured wrap-up when a contract-missing run still authored
   * one — surfaced beside the failure in the run detail. Absent for infra failures / captain. */
  debrief?: RunDebrief;
}

export interface RunProgressPayload {
  completed: number;
  total: number;
}

/** 调度埋点量化 (深层诊断指标, 前端UX设计.md §十): one WaveScheduler run's observability
 * snapshot, surfaced for the client's 诊断模式 (`diagnosticMode`). A delegate turn emits one
 * per scheduler segment (a checkpoint / scope yield + resume emits another), so the desktop
 * fold accrues a list on `Execution.batches`; the run-detail 诊断信息 reads it. Journaled (it
 * rides a delegate turn alongside `run_plan`), so it replays on reload. `busy_ms / wall_ms ≈`
 * 平均并发; `slot_starved > 0` ⇒ the `width` cap throttled ready nodes. The boundary tallies
 * count 受监督波循环 yields fired THIS segment (bind 晚绑定 / scope 漂移返工 / checkpoint 复核);
 * the escalate tallies are raw (`scope_escalations ⊆ escalations`). Desktop-only diagnostic
 * surface — the mobile fold no-ops it (no 诊断 panel), so it is NOT in the conformance
 * ProjectedTurn. */
/** 多任务并行图 (并行时间线): one dispatched node's occupancy window — ms offsets from the
 * scheduler's wall start (same t0 as `wall_ms`). `outcome` is the terminal RunPhase value
 * (`completed`/`failed`). Only dispatched nodes appear (cascade-skipped omitted). */
export interface NodeTimingPayload {
  run_id: string;
  start_ms: number;
  end_ms: number;
  outcome: string;
}

export interface BatchMetricsPayload {
  execution_id: string;
  nodes: number;
  width: number;
  peak_running: number;
  wall_ms: number;
  busy_ms: number;
  slot_starved: number;
  completed: number;
  failed: number;
  skipped: number;
  bind_boundaries: number;
  scope_boundaries: number;
  checkpoint_boundaries: number;
  escalations: number;
  scope_escalations: number;
  /** 多任务并行图 (并行时间线): per-node occupancy windows (offsets from wall start), so the
   * desktop can render real temporal parallelism. Dispatched nodes only; host sorts by start. */
  timeline: NodeTimingPayload[];
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
  /** 该方辩手的【模型覆写】（真·多模型辩论）：`provider/model`（如 `doubao/doubao-seed-2-1-turbo
   *  -260628`）经 ProviderRouter 路由到对应厂商，无前缀=默认 DeepSeek，空=平台默认。前端据此标
   *  「正方=豆包 / 反方=DeepSeek」徽章——「谁更聪明」对战的核心可读性。**新增字段**：早于本特性
   *  journaled 的 debate_result 事件可能缺省，重载时按空处理（不显徽章）。 */
  model?: string;
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

/** 用户在某轮边界注入的【追问】（交互式逐轮，opt-in）：`ask` 是要辩手正面回答的问题，`target_key`
 * 指定方（{@link DebateSideInfo.key}，空=问全场），`answered` 是结构事实——是否真有后续轮承接它
 * （追问即续辩，正常恒 true；轮数上限边界追问 / 紧接超时无后续轮则 false，非「答得好不好」判断）。
 * 唯一耐久的用户追问痕迹（决策事件 transport-only 不入 journal），随 {@link DebateRoundInfo} 进
 * `debate_result` 复盘可见。 */
export interface DebateUserInterjection {
  ask: string;
  target_key: string;
  answered: boolean;
}

/** 质询环节的一条 Q↔A（质询回合 P1）：主持人向某方发出的单条必答质询 + 该条作答 +
 * 是否正面回答（回避 / 失败 → false）。 */
export interface DebateCrossExamExchange {
  question: string;
  answer: string;
  ok: boolean;
}

/** 质询环节对某一方的一组逐条交换（质询回合 P1）：主持人代表交锋向某方（`target` =
 * {@link DebateSideInfo.key}）发出【必须正面回答】的尖锐质询，被质询方在【自己的 transcript】
 * 上逐条作答——`exchanges` 承载逐条 Q↔A（问题 + 作答摘要 verbatim；完整作答流仍随
 * `answer_run_id` 的辩手 run 事件走，供侧面板钻取）。`questioner` 空=主持人代表交锋（当前实现）。
 * 随 {@link DebateRoundInfo} 进 `debate_result`；仅【认真辩透 + 对抗形态】开启，非质询路径为空数组、
 * 可缺省（渐进式契约扩展，旧产物 / 快速对碰兼容）。 */
export interface DebateCrossExam {
  target: string;
  questioner: string;
  exchanges: DebateCrossExamExchange[];
  answer_run_id: string;
}

/** 某方的【结辩陈词】（阶段化发言角色 P4 · 结辩收束）：辩已辩尽（收敛 / 用户 conclude / 达上限）后、
 * 简报前，各方在【自己的 transcript】上做的一段收尾 advocacy——`key`/`name` 是 {@link DebateSideInfo}
 * 身份，陈词【全文】随 `run_id` 的辩手 run 事件走（与各方发言 / 质询作答同策，不塞载荷），前端据 `run_id`
 * 从执行图节点取回全文。`ok` 标记是否成功产出（失败 / 无 session → false，前端标「未产出结辩」）。这一层
 * 是辩手自己的胜负手收束，与裁判中立的 {@link DebateBriefInfo.decisive} 正交并存（真人辩论：结辩 + 裁决
 * 并存）。仅【认真辩透 + 对抗形态】开启；快速对碰 / 圆桌 / 旧产物为空数组、可缺省（渐进式契约扩展）。 */
export interface DebateClosing {
  key: string;
  name: string;
  run_id: string;
  ok: boolean;
}

/** 某方在某一轮的记分（记分裁判 P2）：裁判在**辩论领域内**给各方本轮打分——`argument` 论点强度、
 * `engagement` 回应完整度（是否正面回应对方命门与质询、有无回避）、`evidence` 证据充分度，各 0–5；
 * `penalties` 记本轮谬误与未支撑主张（每条一句话，如「循环论证：拿未生效判决当论据」），每条计 -1；
 * `note` 一句话记分理由；`total` 净得分（三维和减罚分，可为负，后端预算好、前端直用不重算）。逐轮记分
 * 累计驱动收场 {@link DebateBriefInfo.leaning}/`decisive`，让倾向与实际交锋对齐。随 {@link DebateRoundInfo}
 * 进 `debate_result`；未开启记分（快速对碰 / 坏 JSON 容错）为空对象、可缺省（渐进式契约扩展）。 */
export interface DebateRoundScore {
  argument: number;
  engagement: number;
  evidence: number;
  penalties: string[];
  note: string;
  total: number;
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
  /** 驱动本轮的用户追问（交互式逐轮，opt-in；非交互 / 无追问为空数组）。可缺省（旧产物兼容，
   * 与 {@link DebateBriefInfo.risk_severities} 同样的渐进式契约扩展）。 */
  user_interjections?: DebateUserInterjection[];
  /** 本轮质询环节的问答（质询回合 P1）：主持人代表交锋的定向必答质询 + 各方作答指针。非质询路径
   * （快速对碰 / 圆桌 / 旧产物）为空数组、可缺省（渐进式契约扩展）。见 {@link DebateCrossExam}。 */
  cross_exam?: DebateCrossExam[];
  /** 本轮记分裁判的各方得分（`key` = {@link DebateSideInfo.key} → 三维 + 罚分 + 净分，记分裁判 P2）。
   * 未开启记分（快速对碰 / 旧产物）为空对象、可缺省（渐进式契约扩展）。见 {@link DebateRoundScore}。 */
  scores?: Record<string, DebateRoundScore>;
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
  /** 本轮质询环节的问答（质询回合 P1）：`debate_round` 收尾后写入；质询进行中可由前端据
   * `_cx_` run + `run_context` 从执行图重建。非质询路径为空、可缺省（渐进式契约扩展）。 */
  cross_exam?: DebateCrossExam[];
}

/** 决策简报（结论卡）：交锋焦点、各方最强论点、事实/价值分歧、倾向与置信、建议、待解问题。 */
export interface DebateBriefInfo {
  crux: string;
  strongest_points: Record<string, string>;
  /** 红队专用：红队成员 `key` → 风险严重度 `high|medium|low`，驱动「风险看板」按严重度分级 +
   * 总览计数。非红队形态恒为空对象；被审方案方（`is_subject`）不评级。可缺省（旧产物兼容）。 */
  risk_severities?: Record<string, string>;
  factual_disputes: string[];
  value_disputes: string[];
  /** 胜负手（记分裁判 P2）：一句话点名【谁的哪个论点被驳倒 / 被证伪 / 无据】，据逐轮记分累计推导
   * ——让 `leaning` 由实际交锋记分驱动、可追溯，而非收场拍脑袋。空=未开启记分；可缺省（渐进式
   * 契约扩展，旧产物 / 快速对碰兼容）。圆桌无单一胜负手恒空。 */
  decisive?: string;
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
  /** 主持人开场白（第 1 轮主持人顺带产出的一句定调）：前端顶部「会说话的主持人」气泡渲染。可选、
   *  渐进式契约扩展（旧产物 / 未产出时缺省）——空 / 缺省时前端回落到由 motion+焦点拼出的模板开场白。 */
  opening?: string;
  /** 呈现顺序提示：true=叙事线优先（如 roundtable 探讨），false=简报优先（如 debate 决策）。 */
  narrative_first: boolean;
  sides: DebateSideInfo[];
  rounds: DebateRoundInfo[];
  /** 各方结辩陈词（阶段化发言角色 P4 · 结辩收束）：辩已辩尽后各方的收尾 advocacy，全文随 `run_id` 走
   *  执行事件（不塞载荷）。非结辩路径（快速对碰 / 圆桌 / 旧产物）为空数组、可缺省（渐进式契约扩展）。
   *  见 {@link DebateClosing}。 */
  closings?: DebateClosing[];
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

/** 交互式逐轮辩论（opt-in, 辩论编排设计.md §逐轮交互）：主持人在一轮边界挂起，把「继续辩 /
 * 加角度 / 够了出结论」的决定权交给用户（而非直接采信裁判自判收敛）。`decision_id` 是 resolve
 * 目标（POST …/interactions/{id}, kind=`debate_round`）；`converged`/`rationale` 是裁判对本轮
 * 的判读（决策卡据此高亮默认建议）。Transport-only liveliness：NOT journaled——耐久记录是收场
 * `debate_result`（用户的选择体现在实际发生的轮次 / stop_reason），故重载无此卡、只见收场叙事。 */
export interface DebateRoundDecisionRequiredPayload {
  execution_id: string;
  moderator_run_id: string;
  decision_id: string;
  round_no: number;
  focus: string;
  summary: string;
  converged: boolean;
  rationale: string;
}

/** 交互式逐轮辩论结算：用户在轮边界的抉择（或超时回落）。`decision`：`continue`（再辩一轮）/
 * `conclude`（立即出结论）/ `timeout`（未应答 / 无活跃用户 → 裁判自动收敛接管）。`focus` 是用户
 * 为下一轮注入的「加角度」议题（仅 `continue` 且非空时有值）。Transport-only（`_required` 的孪生，
 * 同样不进 journal）。 */
export interface DebateRoundDecisionResolvedPayload {
  execution_id: string;
  moderator_run_id: string;
  decision_id: string;
  decision: "continue" | "conclude" | "timeout";
  focus: string;
}

export interface MessageEndPayload {
  finish_reason:
    | "end_turn"
    | "max_rounds"
    | "degraded"
    | "unproductive"
    | "error"
    | "cancelled"
    // 挂起即收口 (②): the turn ENDED at a durable checkpoint (ask_user blocking /
    // plan_review) and finalized in place — its frame is persisted and it awaits
    // POST .../resume. NOT done (≠ end_turn) and not aborted (≠ cancelled): the client
    // keeps the turn paused and renders the stream's close as the single resume card.
    | "paused";
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
  context?: {
    upstream_status?: number;
    upstream_body_preview?: string | null;
    retry_attempts?: number;
    empty_diagnosis?: string;
  };
}

export interface TitleGeneratedPayload {
  conversation_id: string;
  title: string;
}

/** BYOK soft gate (开放主流AI模型接入 §4.5): preflight hint when probe says the user's
 * model may lack tool calling. Transport-only — not journaled. */
export interface TurnWarningPayload {
  message: string;
}

// ── AI Town simulation (M1) ───────────────────────────────────────────────────
// Coordinate contract: Vec3 uses R3F/Three.js Y-up; x=east, z=south, y=height (NPC ≈ 0).
// Region anchors are authoritative sync points; frontend NavMesh may nudge locally.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SimAgentState {
  agent_id: string;
  name: string;
  role: string;
  location: string;
  position: Vec3;
  activity: string;
  mood: number;
  goal: string;
  last_thought: string;
  relationships?: Record<string, number>;
  tick_memories?: string[];
  money?: number;
  inventory?: Record<string, number>;
}

export interface SimAgentAction {
  agent_id: string;
  action:
    | "move_to"
    | "stay_here"
    | "speak_to"
    | "propose_trade"
    | "propose_vote"
    | "idle"
    | "error";
  thought: string;
  tool_name?: string | null;
  tool_args?: Record<string, unknown> | null;
  success: boolean;
  detail: string;
}

export interface SimTickStartedPayload {
  run_id: string;
  tick: number;
  hour: number;
}

export interface SimTickEndedPayload {
  run_id: string;
  tick: number;
  hour: number;
  agent_count: number;
}

export interface SimTickFramePayload {
  run_id: string;
  tick_number: number;
  snapshot: Record<string, unknown>;
}

export interface SimAgentStatePayload {
  run_id: string;
  tick: number;
  state: SimAgentState;
}

export interface SimAgentActionPayload {
  run_id: string;
  tick: number;
  action: SimAgentAction;
}

export interface InteractionTranscriptLine {
  speaker_id: string;
  speaker_name: string;
  text: string;
  round: number;
}

export interface InteractionStateChange {
  mood_deltas?: Record<string, number>;
  relation_deltas?: [string, string, number][];
  money_transfers?: Record<string, unknown>[];
  inventory_transfers?: Record<string, unknown>[];
  governance?: Record<string, unknown>;
}

export interface InteractionResult {
  request_id: string;
  kind: "conversation" | "trade" | "vote";
  status: "completed" | "rejected" | "failed" | "cancelled";
  initiator_id: string;
  target_id?: string | null;
  summary: string;
  transcript?: InteractionTranscriptLine[];
  state_changes?: InteractionStateChange;
  detail?: string;
}

export interface SimInteractionPayload {
  run_id: string;
  tick: number;
  interaction: InteractionResult;
}

export interface WorldModifiersWire {
  market_price_multiplier: number;
  storm_active: boolean;
  festival_active: boolean;
  square_attraction_boost: number;
}

export interface WorldEventWire {
  event_id: string;
  kind: string;
  event_type: string;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
  tick_started: number;
  duration_ticks: number;
  source: string;
}

export interface SimWorldEventPayload {
  run_id: string;
  tick: number;
  event: WorldEventWire;
  modifiers: WorldModifiersWire;
}

/** CEO→用户「下一步推荐」(下一步推荐): 2-4 quick-reply suggestions for the just-finished
 * turn, phrased as the user's next message. Generated post-turn by a World B narrow task
 * and emitted after `message_end`; the client attaches them to the latest assistant message
 * as one-click chips (filled into the composer on click). Transport-only — not journaled,
 * not persisted, so like `title_generated` it is a no-op in the conformance ProjectedTurn. */
export interface FollowupsGeneratedPayload {
  conversation_id: string;
  followups: string[];
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

/** One structured whiteboard op the AI emits (AI协作白板.md §六 M2). The closed verb
 * set is shared with the server tool + the desktop applier: `add_node` (a shape with a
 * caller-chosen `ref` handle so later ops can wire to it), `connect` (an arrow `from`→`to`
 * by ref/id), `move` / `set_text` / `delete` (target an existing `id` or a same-batch
 * `ref`), `group` (`members` by ref/id). Fields beyond `op` are op-specific. */
export interface BoardOp {
  op: "add_node" | "connect" | "move" | "set_text" | "delete" | "group";
  ref?: string;
  id?: string;
  kind?: "sticky" | "rectangle" | "ellipse" | "diamond" | "text";
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  from?: string;
  to?: string;
  label?: string;
  members?: string[];
}

/** Transport-only client-tool request: apply a batch of board ops to the user's open
 * whiteboard canvas (`board_id`) and POST the result to the interaction-resolve endpoint
 * (settling the server's `BoardChannel`). The board counterpart of
 * `workspace_op_required`; NOT journaled (a request/response exchange, not turn content). */
export interface BoardOpRequiredPayload {
  request_id: string;
  conversation_id: string;
  board_id: string;
  ops: BoardOp[];
  summary: string;
}

/** Transport-only client-tool request: rasterize a subset of board elements (`ids` — the
 * hand-drawn / screenshot subset of a selection) to a PNG and POST it back to the
 * interaction-resolve endpoint (settling the server's `BoardChannel.read`), so the vision
 * reader can read it (AI协作白板.md §九). The read counterpart of `board_op_required`; NOT
 * journaled. The resolve value carries `{ pngBase64, w, h }`. */
export interface BoardReadRequiredPayload {
  request_id: string;
  conversation_id: string;
  board_id: string;
  ids: string[];
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
  tool_use_progress: ToolUseProgressPayload;
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
  run_output_reset: RunOutputResetPayload;
  run_reasoning_delta: RunReasoningDeltaPayload;
  run_tool_progress: RunToolProgressPayload;
  run_completed: RunCompletedPayload;
  run_failed: RunFailedPayload;
  run_progress: RunProgressPayload;
  batch_metrics: BatchMetricsPayload;
  run_escalation: RunEscalationPayload;
  escalation_required: EscalationRequiredPayload;
  escalation_resolved: EscalationResolvedPayload;
  team_note_posted: TeamNotePostedPayload;
  debate_result: DebateResultPayload;
  debate_round_started: DebateRoundStartedPayload;
  debate_round: DebateRoundPayload;
  debate_round_decision_required: DebateRoundDecisionRequiredPayload;
  debate_round_decision_resolved: DebateRoundDecisionResolvedPayload;
  message_end: MessageEndPayload;
  error: ErrorPayload;
  title_generated: TitleGeneratedPayload;
  turn_warning: TurnWarningPayload;
  "sim.tick_started": SimTickStartedPayload;
  "sim.tick_ended": SimTickEndedPayload;
  "sim.tick_frame": SimTickFramePayload;
  "sim.agent_action": SimAgentActionPayload;
  "sim.agent_state": SimAgentStatePayload;
  "sim.interaction": SimInteractionPayload;
  "sim.world_event": SimWorldEventPayload;
  followups_generated: FollowupsGeneratedPayload;
  turn_saved: TurnSavedPayload;
  citations: CitationsPayload;
  workspace_op_required: WorkspaceOpRequiredPayload;
  board_op_required: BoardOpRequiredPayload;
  board_read_required: BoardReadRequiredPayload;
  handoff_snapshot_done: HandoffSnapshotDonePayload;
  handoff_job_started: HandoffJobStartedPayload;
  handoff_apply_done: HandoffApplyDonePayload;
};
