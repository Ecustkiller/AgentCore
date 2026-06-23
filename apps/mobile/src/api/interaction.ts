import { apiFetch } from "@/api/client";
// Settle a paused interaction over the LIVE SSE stream (交互式暂停放行).
//
// POST to the unified resolve endpoint wakes the awaiter on the open stream.
// REST body types track OpenAPI (cloud-only on mobile — no sidecar branch).
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Settle a paused interaction — discriminated on `kind` (OpenAPI union). */
export type ResolveInteractionBody =
  | Schemas["ResolveApprovalInteraction"]
  | Schemas["ResolveCheckpointInteraction"]
  | Schemas["ResolvePlanReviewInteraction"];

/**
 * POST a paused interaction's answer; the live SSE stream resumes.
 * 404 is swallowed (stale interaction — stream terminal event settles UI).
 */
export async function resolveInteraction(
  conversationId: string,
  interactionId: string,
  body: ResolveInteractionBody,
): Promise<void> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/interactions/${interactionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`放行失败 (${res.status})`);
  }
}
