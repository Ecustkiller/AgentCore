/**
 * Diagnostic LLM window REST contract.
 *
 * Aligns with `apps/server/agentcore/api/schemas/llm_window.py` and
 * `GET /v1/conversations/{id}/messages/{mid}/runs/{run_id}/llm-window`.
 */

export type LlmWindowRole = "system" | "user" | "assistant" | "tool";

export interface LlmWindowToolCallFunction {
  name: string;
  arguments: string;
}

export interface LlmWindowToolCall {
  id: string;
  type: "function";
  function: LlmWindowToolCallFunction;
}

export interface LlmWindowMessage {
  role: LlmWindowRole;
  content?: string | null;
  tool_calls?: LlmWindowToolCall[] | null;
  tool_call_id?: string | null;
  reasoning_content?: string | null;
}

/** `GET .../runs/{run_id}/llm-window` response. */
export interface RunLlmWindowResponse {
  run_id: string;
  available: boolean;
  messages: LlmWindowMessage[];
}
