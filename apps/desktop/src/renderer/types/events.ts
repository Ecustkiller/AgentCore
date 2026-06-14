export type SSEEventType =
  | "message_start"
  | "content_delta"
  | "reasoning_delta"
  | "tool_use_start"
  | "tool_use_end"
  | "approval_required"
  | "approval_resolved"
  | "ask_user_requested"
  | "run_plan"
  | "plan_review_required"
  | "plan_review_resolved"
  | "run_started"
  | "run_output_delta"
  | "run_completed"
  | "run_failed"
  | "run_retrying"
  | "run_progress"
  | "checkpoint_review"
  | "task_state_updated"
  | "pipeline_summary"
  | "message_end"
  | "error"
  | "title_generated"
  | "turn_saved";

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

export interface ToolUseStartPayload {
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ToolUseEndPayload {
  tool_call_id: string;
  tool_name: string;
  result: string;
  status: "success" | "error";
}

export interface ApprovalRequiredPayload {
  checkpoint_id: string;
  after_step: string;
  summary: string;
  reason: string;
  actions: ("approve" | "adjust" | "stop")[];
}

export interface ApprovalResolvedPayload {
  checkpoint_id: string;
  action: "approve" | "adjust" | "stop";
}

export interface AskUserRequestedPayload {
  request_id: string;
  question: string;
}

/** Roster entry shared by run_plan + plan_review_required. `thinking` /
 * `reasoning_effort` are the *effective* values (tier default folded with any
 * per-agent override), so the graph/preview show exactly what will run. */
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
  steps: Array<{
    id: string;
    agent_id: string;
    task: string;
    depends_on: string[];
  }>;
}

export interface PlanReviewRequiredPayload {
  review_id: string;
  execution_id: string;
  agents: PlanAgentPayload[];
}

export interface PlanReviewResolvedPayload {
  review_id: string;
  action: "start" | "cancel";
}

export interface RunStartedPayload {
  run_id: string;
  agent_id: string;
  step_id: string;
}

export interface RunOutputDeltaPayload {
  run_id: string;
  agent_id: string;
  delta: string;
}

export interface RunCompletedPayload {
  run_id: string;
  agent_id: string;
  output_summary: string;
  duration_ms: number;
}

export interface RunFailedPayload {
  run_id: string;
  agent_id: string;
  error: string;
}

export interface RunRetryingPayload {
  run_id: string;
  agent_id: string;
  attempt: number;
  reason: string;
}

export interface RunProgressPayload {
  completed: number;
  total: number;
}

export interface CheckpointReviewPayload {
  checkpoint_id: string;
  after_step: string;
  decision: "continue" | "adjust" | "escalate";
  reason: string;
  summary: string;
}

export interface TaskStateUpdatedPayload {
  snapshot: Record<string, unknown>;
}

export interface PipelineSummaryPayload {
  final_result: string;
  total_duration_ms: number;
  agents_used: number;
  steps_completed: number;
}

export interface MessageEndPayload {
  finish_reason: "end_turn" | "max_rounds" | "degraded" | "error" | "cancelled";
  usage?: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
  };
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

export type SSEPayloadMap = {
  message_start: MessageStartPayload;
  content_delta: ContentDeltaPayload;
  reasoning_delta: ReasoningDeltaPayload;
  tool_use_start: ToolUseStartPayload;
  tool_use_end: ToolUseEndPayload;
  approval_required: ApprovalRequiredPayload;
  approval_resolved: ApprovalResolvedPayload;
  ask_user_requested: AskUserRequestedPayload;
  run_plan: RunPlanPayload;
  plan_review_required: PlanReviewRequiredPayload;
  plan_review_resolved: PlanReviewResolvedPayload;
  run_started: RunStartedPayload;
  run_output_delta: RunOutputDeltaPayload;
  run_completed: RunCompletedPayload;
  run_failed: RunFailedPayload;
  run_retrying: RunRetryingPayload;
  run_progress: RunProgressPayload;
  checkpoint_review: CheckpointReviewPayload;
  task_state_updated: TaskStateUpdatedPayload;
  pipeline_summary: PipelineSummaryPayload;
  message_end: MessageEndPayload;
  error: ErrorPayload;
  title_generated: TitleGeneratedPayload;
  turn_saved: TurnSavedPayload;
};
