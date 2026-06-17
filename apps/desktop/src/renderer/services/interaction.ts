import { api } from "@/services/api";
import { getActiveSidecarTarget } from "@/services/sidecarRouting";
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
 * Settle a paused interaction's answer over whichever transport is running this turn.
 *
 * The single choke point for every kind (approval / ask_user / plan_review), so the
 * cloud-vs-local routing lives in ONE place:
 *
 * - **Local (sidecar) turn** → the engine awaits in the user's `python -m
 *   agentcore.sidecar` process, whose in-process `InteractionRegistry` a cloud HTTP
 *   POST can never reach. Route to `window.sidecarApi.respond` instead — same wire
 *   body (the main process forwards it; the sidecar builds the kind-specific result
 *   identically, see `interaction_result_from_body`). A stale settle just resolves
 *   `{resolved:false}` and is a no-op for the caller (mirrors the cloud 404).
 * - **Cloud turn** → POST the unified resolve endpoint; the awaiter in the live
 *   `send_message` SSE stream resumes. A 404 means the interaction is stale (timed
 *   out, already settled, the turn ended, or its kind does not match).
 */
export async function resolveInteraction(
  conversationId: string,
  interactionId: string,
  body: ResolveInteractionBody,
): Promise<void> {
  const sidecarTarget = getActiveSidecarTarget(conversationId);
  if (sidecarTarget) {
    await window.sidecarApi.respond({
      rootId: sidecarTarget.rootId,
      subpath: sidecarTarget.subpath,
      requestId: interactionId,
      conversationId,
      result: body,
    });
    return;
  }
  await api.post(
    `/v1/conversations/${conversationId}/interactions/${interactionId}`,
    body,
  );
}
