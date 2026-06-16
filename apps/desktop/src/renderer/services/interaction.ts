import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/**
 * Unified suspend-resume bridge (§18.2): a single endpoint settles any paused
 * interaction — a tool approval, an `ask_user` checkpoint, a `plan_review` DAG
 * checkpoint (结构化挂起 2a), or a local-workspace op. The body is discriminated on
 * `kind`, so callers build their kind-specific shape.
 */
export type ResolveInteractionBody =
  | Schemas["ResolveApprovalInteraction"]
  | Schemas["ResolveCheckpointInteraction"]
  | Schemas["ResolveClientToolInteraction"]
  | Schemas["ResolvePlanReviewInteraction"];

/**
 * POST a paused interaction's answer to the unified resolve endpoint.
 *
 * The pending awaiter in the live `send_message` SSE stream resumes with the
 * kind-specific result. A 404 means the interaction is stale (timed out, already
 * settled, the turn ended, or its kind does not match) — each caller decides how
 * to treat that.
 */
export async function resolveInteraction(
  conversationId: string,
  interactionId: string,
  body: ResolveInteractionBody,
): Promise<void> {
  await api.post(
    `/v1/conversations/${conversationId}/interactions/${interactionId}`,
    body,
  );
}
