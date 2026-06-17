export type SSEEventType =
  | "message_start"
  | "content_delta"
  | "reasoning_delta"
  | "tool_progress"
  | "tool_use_start"
  | "tool_use_end"
  | "approval_required"
  | "approval_resolved"
  | "checkpoint_required"
  | "checkpoint_resolved"
  | "plan_review_required"
  | "plan_review_resolved"
  | "run_plan"
  | "run_started"
  | "run_output_delta"
  | "run_reasoning_delta"
  | "run_tool_progress"
  | "run_completed"
  | "run_failed"
  | "run_progress"
  | "message_end"
  | "error"
  | "title_generated"
  | "turn_saved"
  | "citations"
  | "workspace_op_required"
  | "handoff_snapshot_done"
  | "handoff_job_started"
  | "handoff_apply_done";

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  timestamp: string;
  payload: T;
}

export interface MessageStartPayload {
  message_id: string;
  conversation_id: string;
}

export interface ContentDeltaPayload {
  delta: string;
}

export interface ReasoningDeltaPayload {
  delta: string;
}

/** The CEO captain is composing a tool call's ARGUMENTS (bubble-scoped twin of
 * `RunToolProgressPayload`). `chars` is the cumulative length of the streamed
 * argument string so far — for the prime case (`delegate`) the task book growing.
 * The captain's voice is the chat bubble and its big delegate call assembles before
 * `run_plan` fires (no graph yet), so this drives a live「正在生成 {tool}…」line on
 * the assistant bubble. Transport-only: never journaled. */
export interface ToolProgressPayload {
  tool_name: string;
  chars: number;
}

export interface ToolUseStartPayload {
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

/** One web hit in a `web_search` tool's structured display (工具结果富渲染): a
 * result card's data (favicon via `site` · `title` · `snippet`). */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Display host (sans www.), parsed server-side so the card needs no URL work. */
  site?: string;
}

/** `web_search` rich result: the query + its hits, shown as source-style cards. */
export interface WebSearchDisplay {
  query: string;
  results: WebSearchHit[];
}

/** `code_execute` rich result: a terminal-style stdout/stderr view + exit code. */
export interface CodeExecDisplay {
  stdout: string;
  stderr: string;
  exit_code: number;
  language: string;
}

/** A tool's OPTIONAL render-oriented payload (工具结果富渲染), distinct from the
 * model-facing `result` text. The desktop keys the renderer off the tool name and
 * narrows this to the matching shape ({@link WebSearchDisplay} / {@link
 * CodeExecDisplay} / …); an unknown or absent display falls back to the `result`
 * text. Opaque on the wire (snake_case, exempt from the generated-types rule like
 * the rest of the runs payload). */
export type ToolDisplay = Record<string, unknown>;

export interface ToolUseEndPayload {
  tool_call_id: string;
  tool_name: string;
  result: string;
  status: "success" | "error";
  /** Rich rendering data for tools that have one (工具结果富渲染); absent for the
   * many tools whose text `result` is enough. */
  display?: ToolDisplay | null;
}

/** One step in a single-agent turn's 思考+工具 process timeline (前端UX设计.md §一).
 * The CEO's own reasoning interleaved with its tool calls, in turn order: a
 * `reasoning` step coalesces consecutive thinking deltas; a `tool` step records one
 * call, resolved (result + status) by its matching `tool_use_end`. Built live from
 * the SSE stream (streamConversation) and persisted on `messages.runs.process`
 * (snake_case wire shape — exempt from the generated-types rule like the rest of
 * the runs payload) so a reloaded turn replays the same inline panel. */
export type ProcessStep =
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      id: string;
      tool_name: string;
      arguments: Record<string, unknown>;
      result: string | null;
      status: "running" | "success" | "error";
      /** Rich rendering data resolved on `tool_use_end` (工具结果富渲染); absent
       * for tools whose text `result` is enough. Persisted on the step so a
       * reloaded turn renders the same card. */
      display?: ToolDisplay | null;
    };

/** The user's settlement of a paused GRANTABLE tool call; mirrors the backend
 * `ApprovalDecision`. `approve` allows this one call, `approve_always` allows the
 * tool for the rest of the turn, `approve_always_files` allows the whole
 * file-mutation class (file_write / str_replace / file_delete / file_move) for the
 * turn — code_execute stays separately gated — and `deny` refuses it. */
export type ApprovalDecision =
  | "approve"
  | "approve_always"
  | "approve_always_files"
  | "deny";

/** A GRANTABLE tool call (CEO chat path) is paused awaiting the user's
 * authorization. `approval_id` is echoed back to the resolve endpoint (it equals
 * `tool_call_id`); `arguments` is a size-bounded preview from the backend so the
 * user sees what the tool would do before allowing it. */
export interface ApprovalRequiredPayload {
  approval_id: string;
  conversation_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

/** A pending approval was settled (approve / approve_always / deny / timeout) so
 * the client can clear the inline prompt. A timeout resolves as `deny`. */
export interface ApprovalResolvedPayload {
  approval_id: string;
  tool_call_id: string;
  decision: ApprovalDecision;
}

/** The user's settlement of a checkpoint the CEO raised (ask_user); mirrors the
 * backend `CheckpointDecision`. `continue` proceeds with the CEO's direction,
 * `adjust` steers it with a note then continues, `stop` ends the turn; `timeout`
 * is engine-set only (a no-answer deadline) and never sent by the client. */
export type CheckpointDecision = "continue" | "adjust" | "stop" | "timeout";

/** One 起步计划 chip on an ask_user card (开场引导): a low-impact, reversible
 * decision the CEO made for the user, shown read-only as 「label + value」. */
export interface AskAssumption {
  id: string;
  label: string;
  value: string;
}

/** One askable item on an ask_user card: the focal fork mid-task (usually one, no
 * `default`), or a high-leverage opening decision pre-filled with the CEO's
 * `default` so a 想省事 user can one-click accept it all. `kind` "choice" picks
 * from `options` (single- or `multiple`-select); "text" is a free-form fill (its
 * `options`/`multiple` cleared server-side). */
export interface AskQuestion {
  id: string;
  prompt: string;
  kind: "choice" | "text";
  options: string[];
  multiple: boolean;
  default: string;
}

/** One 风格预设 on an ask_user card — offered only for visual products (网站 / 海报
 * / 幻灯…); non-visual asks omit them. */
export interface AskStyleOption {
  id: string;
  label: string;
}

/** The CEO paused the turn to ask the user (ask_user — the one asking surface,
 * covering both an opening 引导 and a mid-task fork). `checkpoint_id` is echoed back
 * to the resolve endpoint; `question` is the framing / opening line (always shown);
 * `context` is optional background. The rich opening content is optional (empty for
 * a compact mid-task fork): `assumptions` (起步计划 chips), `questions` (the askable
 * items), `style_options` (风格预设). Journaled (unlike approvals), so it replays
 * inline on reload. */
export interface CheckpointRequiredPayload {
  checkpoint_id: string;
  conversation_id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  style_options: AskStyleOption[];
}

/** A pending checkpoint was settled (continue / adjust / stop / timeout). `note`
 * carries the user's steer for `adjust` (or a closing remark for `stop`);
 * `selected` the option(s) the user picked. Journaled alongside
 * `checkpoint_required` so the outcome replays on reload. */
export interface CheckpointResolvedPayload {
  checkpoint_id: string;
  decision: CheckpointDecision;
  note: string;
  selected?: string[];
}

/** One just-completed checkpoint step under review (plan_review, 结构化挂起 2a):
 * the worker's `role` + a capped excerpt of its `summary`, so the user recognises
 * what just finished before deciding whether to release the downstream steps. */
export interface PlanReviewStep {
  run_id: string;
  role: string;
  summary: string;
}

/** A downstream node gated behind a plan_review pause (about to run once the user
 * proceeds): just `run_id` + `role` for a compact「待运行」preview. */
export interface PlanReviewPending {
  run_id: string;
  role: string;
}

/** The WaveScheduler paused after a `checkpoint_after` step completed and before
 * its dependents run (结构化挂起 2a). `checkpoint_id` is echoed back to the resolve
 * endpoint; `steps` are the just-completed nodes under review, `pending` peeks at
 * the downstream nodes being gated. Journaled (like ask_user checkpoints) so the
 * pause replays inline on reload. */
export interface PlanReviewRequiredPayload {
  checkpoint_id: string;
  conversation_id: string;
  steps: PlanReviewStep[];
  pending: PlanReviewPending[];
}

/** A pending plan_review was settled (continue / stop / timeout). `note` carries
 * an optional remark. Journaled alongside `plan_review_required` so the outcome
 * replays on reload. Reuses `CheckpointDecision` — the backend shares the enum;
 * 2a never sends `adjust`. */
export interface PlanReviewResolvedPayload {
  checkpoint_id: string;
  decision: CheckpointDecision;
  note: string;
}

/** Roster entry used by run_plan. `thinking` / `reasoning_effort` are the
 * *effective* values (tier default folded with any per-agent override), so the
 * graph shows exactly what will run. */
export interface PlanAgentPayload {
  id: string;
  role: string;
  model_preference: "fast" | "strong";
  thinking: boolean;
  reasoning_effort: "high" | "max" | null;
}

export interface RunPlanPayload {
  execution_id: string;
  plan_type: "single_agent" | "multi_agent";
  task_summary: string;
  agents: PlanAgentPayload[];
  runs: Array<{
    id: string;
    agent_id: string;
    task: string;
    depends_on: string[];
    /** Delegating run id (阶段2 nested delegation). A sub-worker carries its
     * captain worker's run id — a real node on this graph — so the frontend
     * groups it under that parent; a top-level worker carries the CEO captain
     * run id (no node here) or null. Declared at plan time so the structural
     * graph layout can group without waiting for run_started. Optional: a
     * single-batch / older stream may omit it. */
    parent_run_id?: string | null;
    /** Node kind (default `agent`). The top-level delegate batch declares the
     * CEO chat loop as the `captain` root so the graph adopts it as the real
     * 汇聚点 every worker hangs under. */
    kind?: RunKind;
    /** 辩论/审查 呈现标记 (前端UX设计.md §四, display-only): this run's side in an
     * opposing batch (`pro`/`con`), the `group` it is paired in, and its `round`
     * (真·多轮辩论 turn, 1-based; absent/0 = not multi-round). Present only when the
     * CEO marked a debate/review; ordinary parallel/DAG runs omit them. Ride here
     * purely so the frontend can render正反 side-by-side under a「辩论」title and lay
     * rounds out 逐轮 — the executor ignores them. */
    stance?: Stance;
    group?: string;
    round?: number;
  }>;
}

/** What a run node *is*. The CEO chat loop is the turn's `captain` root (the
 * 汇聚点 every worker hangs under); a delegated / DAG worker is an `agent`.
 * No arena/debate kind: a multi-round debate is an ordinary `agent` DAG carrying
 * stance/round display tags, and best-of-N is the backend `RunPolicy.candidates`
 * slot — 形状是数据不是模式. Mirrors the backend `RunKind` enum. */
export type RunKind = "agent" | "captain";

/** A 辩论/审查 node's side (前端UX设计.md §四): the display-only opposition tag the
 * CEO sets via delegate's `stance`. The frontend pairs `pro`/`con` into a
 * side-by-side comparison under a「辩论」title; the backend executor never reads
 * it (执行 stays普通并行 — 守住「形状是数据不是模式」). Mirrors the backend enum. */
export type Stance = "pro" | "con";

export interface RunStartedPayload {
  run_id: string;
  agent_id: string;
  /** Delegating run; `null` at the turn root (阶段2 nesting slot). For a revision
   * (`revision >= 2`) this is the ORIGINAL run being revised. */
  parent_run_id: string | null;
  kind: RunKind;
  /** 定向唤回 续写 version (乙 热修 P4): 0 for an ordinary run, `>= 2` for a revision
   * (original = v1, first revision = v2). Drives the「修订 vN」child node + version
   * chain. Optional so an older journal (no revisions) still maps (→ 0). */
  revision?: number;
}

export interface RunOutputDeltaPayload {
  run_id: string;
  agent_id: string;
  delta: string;
}

/** A worker run's thinking increment (run-scoped twin of run_output_delta). */
export interface RunReasoningDeltaPayload {
  run_id: string;
  agent_id: string;
  delta: string;
}

/** A worker is actively composing a tool call's ARGUMENTS (run-scoped liveliness).
 * `chars` is the cumulative length of the streamed argument string so far (the file
 * body for file_write, the query for a search…), so the team UI can show
 * 「正在生成 {tool} · N 字」on the node/detail while a long tool-call assembles —
 * which otherwise surfaces nowhere (it is neither content nor reasoning, and
 * `tool_use_start` fires only once the args finish). Transport-only: never
 * journaled, so a reloaded run replays the finished call instead. */
export interface RunToolProgressPayload {
  run_id: string;
  agent_id: string;
  tool_name: string;
  chars: number;
}

/** Token counts in the ledger short-key form ({input, output, reasoning,
 * cache_hit, cache_miss}); matches the REST `UsageBreakdown` + cost_events.tokens.
 * NOTE: `message_end.usage` instead uses the legacy `*_tokens` keys (see
 * `MessageEndPayload`). `cache_hit + cache_miss === input`; `reasoning ⊆ output`. */
export interface UsageBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache_hit: number;
  cache_miss: number;
}

/** A run's / turn's cost in integer nano-USD (1 USD = 1e9), never float. `cached`
 * re-states the cache-hit portion of `input` (省了多少); `total === input + output`.
 * All-zero means "no metered cost" → render as「—」, not「¥0.00」(§七5). */
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
  /** Cost-ledger role category (阶段1 scheduled runs are always "member"). */
  role: string;
  model: string;
  /** Lights up one team-payroll row live; zeros until the run metered the LLM. */
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

export interface MessageEndPayload {
  finish_reason: "end_turn" | "max_rounds" | "degraded" | "error" | "cancelled";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
  };
  /** Turn total cost (sum of every run's price = 回合总账); `null` on the
   * error / not-found paths where no turn ran. */
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

/** One web source consulted for an assistant message (source-card data). */
export interface Citation {
  url: string;
  title: string;
  snippet?: string;
  /** Display hostname (sans leading www.); may be empty if unparseable. */
  site?: string;
}

export interface CitationsPayload {
  citations: Citation[];
}

/** A server-side `LocalWorkspace` op (双模式工作区 P2) that the bound desktop must
 * run against the real local directory, then POST the result to the ops resolve
 * endpoint keyed by `request_id`. `root_id` names which authorized FS root to use;
 * `args` is the full op payload (NOT a preview — the client actually executes it).
 * Emitted only in local mode; in cloud mode no such event ever arrives. */
export interface WorkspaceOpRequiredPayload {
  request_id: string;
  conversation_id: string;
  root_id: string;
  op: string;
  args: Record<string, unknown>;
}

/** A local→云 handoff snapshot (双模式工作区 P2e / e1) completed: the bound desktop
 * archived its local workspace over the channel and the server snapshotted it to
 * object storage. `snapshot_id` lands in the same snapshot list as cloud versions;
 * `size_bytes` is the stored archive size. Emitted once before the handoff SSE
 * closes (only on the dedicated handoff stream — never the chat stream). */
export interface HandoffSnapshotDonePayload {
  snapshot_id: string;
  conversation_id: string;
  size_bytes: number;
}

/** A local→云 handoff cloud job (双模式工作区 P2e / e2) was accepted: the base
 * snapshot of the user's local files is captured and an Agent team run is spawned
 * detached on the server. `job_id` is what the client polls (`GET …/handoff/jobs`)
 * for status; `job_conversation_id` is the hidden conversation hosting the team's
 * replayable graph. Emitted once before the dispatch SSE closes — the cloud run
 * keeps going in the background past it. */
export interface HandoffJobStartedPayload {
  job_id: string;
  conversation_id: string;
  job_conversation_id: string;
}

/** One file's outcome in a handoff apply (双模式工作区 P2e / e3). `status` mirrors
 * the server's authoritative verdict: `applied` (cloud version written), `skipped`
 * (kept local, or already byte-identical), `conflict` (diverged locally since the
 * base and not forced — left untouched), `error` (the write/delete op failed).
 * `change_type` is the diff kind (null only on an error before it was known). */
export interface HandoffApplyResult {
  path: string;
  status: "applied" | "skipped" | "conflict" | "error";
  change_type: "added" | "modified" | "deleted" | null;
  detail: string;
}

/** A local→云 handoff apply (双模式工作区 P2e / e3) finished writing back: the
 * selected result changes were replayed onto the local workspace over the channel
 * (WRITE_BYTES / DELETE). Carries the per-file `results` plus rolled-up counts so
 * the PR card can mark each row done and surface any unresolved conflicts. Emitted
 * once, just before the apply SSE closes. */
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
  reasoning_delta: ReasoningDeltaPayload;
  tool_progress: ToolProgressPayload;
  tool_use_start: ToolUseStartPayload;
  tool_use_end: ToolUseEndPayload;
  approval_required: ApprovalRequiredPayload;
  approval_resolved: ApprovalResolvedPayload;
  checkpoint_required: CheckpointRequiredPayload;
  checkpoint_resolved: CheckpointResolvedPayload;
  plan_review_required: PlanReviewRequiredPayload;
  plan_review_resolved: PlanReviewResolvedPayload;
  run_plan: RunPlanPayload;
  run_started: RunStartedPayload;
  run_output_delta: RunOutputDeltaPayload;
  run_reasoning_delta: RunReasoningDeltaPayload;
  run_tool_progress: RunToolProgressPayload;
  run_completed: RunCompletedPayload;
  run_failed: RunFailedPayload;
  run_progress: RunProgressPayload;
  message_end: MessageEndPayload;
  error: ErrorPayload;
  title_generated: TitleGeneratedPayload;
  turn_saved: TurnSavedPayload;
  citations: CitationsPayload;
  workspace_op_required: WorkspaceOpRequiredPayload;
  handoff_snapshot_done: HandoffSnapshotDonePayload;
  handoff_job_started: HandoffJobStartedPayload;
  handoff_apply_done: HandoffApplyDonePayload;
};
