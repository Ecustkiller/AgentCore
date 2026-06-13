/**
 * SSE event type definitions for frontend consumption.
 * These mirror the backend event types.
 */

export interface ExecutionStartedPayload {
  plan_type: "single_agent" | "multi_agent";
  task_summary: string;
  agents: Array<{ id: string; role: string }>;
  steps: Array<{ id: string; agent_id: string; task: string; depends_on: string[] }>;
}

export interface StepOutputChunkPayload {
  step_id: string;
  agent_id: string;
  chunk: string;
}

export interface StepCompletedPayload {
  step_id: string;
  agent_id: string;
  output_summary: string;
  duration_ms: number;
}

export interface CheckpointTriggeredPayload {
  checkpoint_id: string;
  after_step: string;
  summary: string;
  reason: string;
  actions: ("approve" | "adjust" | "stop")[];
}

export interface ExecutionCompletedPayload {
  final_result: string;
  total_duration_ms: number;
  agents_used: number;
  steps_completed: number;
}
