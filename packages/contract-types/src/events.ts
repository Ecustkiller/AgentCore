// SSE event contract — the single shared source for both desktop and mobile folds
// (手机端落地设计 §六 支柱2). Extracted from apps/desktop/src/renderer/types/events.ts
// (the prior hand-written source); ideally generated from the backend
// runtime/events.py EventType + payload builders. Both ends import THIS union and
// fold with a `switch` + `assertNever`, so a new backend event type breaks the
// build until every fold handles it.

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
  | "question_posted"
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
 * `RunToolProgressPayload`). Transport-only liveliness: never journaled. */
export interface ToolProgressPayload {
  tool_name: string;
  chars: number;
}

export interface ToolUseStartPayload {
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
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
