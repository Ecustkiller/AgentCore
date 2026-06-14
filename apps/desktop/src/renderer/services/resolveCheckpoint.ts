const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export type CheckpointAction = "approve" | "adjust" | "stop";

/**
 * Resolve a suspended checkpoint with the user's decision.
 *
 * Unblocks the multi-agent run awaiting this interaction on the backend. The
 * run then resumes (approve/adjust) or winds down (stop), with the outcome
 * streamed back over the same SSE channel as `approval_resolved` + `run_*`.
 */
export async function resolveCheckpoint(
  conversationId: string,
  checkpointId: string,
  action: CheckpointAction,
  feedback?: string,
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/v1/conversations/${conversationId}/checkpoints/${checkpointId}/resolve`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, feedback: feedback ?? null }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve checkpoint: ${response.status}`);
  }
}
