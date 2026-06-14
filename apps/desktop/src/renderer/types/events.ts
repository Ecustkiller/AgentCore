export type SSEEventType =
  | "message_start"
  | "content_delta"
  | "reasoning_delta"
  | "tool_use_start"
  | "tool_use_end"
  | "approval_required"
  | "approval_resolved"
  | "run_plan"
  | "run_started"
  | "run_output_delta"
  | "run_reasoning_delta"
  | "run_completed"
  | "run_failed"
  | "run_progress"
  | "message_end"
  | "error"
  | "title_generated"
  | "turn_saved"
  | "citations";

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

/** The user's settlement of a paused GRANTABLE tool call; mirrors the backend
 * `ApprovalDecision`. `approve` allows this one call, `approve_always` allows the
 * tool for the rest of the turn, `deny` refuses it. */
export type ApprovalDecision = "approve" | "approve_always" | "deny";

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
  }>;
}

/** What a run node *is*. 阶段1 only ever emits `agent`; `arena` / `synthesis`
 * are 阶段2 declaration slots, pre-wired so nested/synthesis nodes need no
 * later contract change. */
export type RunKind = "agent" | "arena" | "synthesis";

export interface RunStartedPayload {
  run_id: string;
  agent_id: string;
  /** Delegating run; `null` at the turn root (阶段2 nesting slot). */
  parent_run_id: string | null;
  kind: RunKind;
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

export type SSEPayloadMap = {
  message_start: MessageStartPayload;
  content_delta: ContentDeltaPayload;
  reasoning_delta: ReasoningDeltaPayload;
  tool_use_start: ToolUseStartPayload;
  tool_use_end: ToolUseEndPayload;
  approval_required: ApprovalRequiredPayload;
  approval_resolved: ApprovalResolvedPayload;
  run_plan: RunPlanPayload;
  run_started: RunStartedPayload;
  run_output_delta: RunOutputDeltaPayload;
  run_reasoning_delta: RunReasoningDeltaPayload;
  run_completed: RunCompletedPayload;
  run_failed: RunFailedPayload;
  run_progress: RunProgressPayload;
  message_end: MessageEndPayload;
  error: ErrorPayload;
  title_generated: TitleGeneratedPayload;
  turn_saved: TurnSavedPayload;
  citations: CitationsPayload;
};
