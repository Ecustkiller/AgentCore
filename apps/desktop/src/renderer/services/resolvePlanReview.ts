import type { ModelTier, ReasoningEffort } from "@/stores/execution";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export type PlanReviewAction = "start" | "cancel";

/** One agent's user-chosen override (tier + reasoning depth, 提案 B). */
export interface AgentOverride {
  model_preference: ModelTier;
  thinking: boolean;
  reasoning_effort: ReasoningEffort;
}

/**
 * Resolve the pre-execution team-preview gate with the user's decision.
 *
 * "start" begins the suspended multi-agent run, applying per-agent model
 * overrides (agent_id -> tier + reasoning depth); "cancel" aborts before
 * anything runs. The outcome streams back over the same SSE channel as
 * `plan_review_resolved` followed by `run_*` (start) or `content_delta` (cancel).
 */
export async function resolvePlanReview(
  conversationId: string,
  reviewId: string,
  action: PlanReviewAction,
  overrides?: Record<string, AgentOverride>,
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/v1/conversations/${conversationId}/plan/${reviewId}/resolve`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, overrides: overrides ?? null }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve plan review: ${response.status}`);
  }
}
