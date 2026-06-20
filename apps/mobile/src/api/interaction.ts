import { apiFetch } from "@/api/client";
// Settle a paused interaction over the LIVE SSE stream (手机端落地设计 P1 · 交互式暂停放行).
//
// When a turn pauses (approval / ask_user checkpoint / plan_review) the backend emits the
// *_required event and then AWAITS on the SAME open stream (stream.ts keeps reading the
// fetch body; the backend heartbeats `: ping`). POSTing the user's decision to the unified
// resolve endpoint (api/routes/conversations.py::resolve_interaction) wakes that awaiter,
// and the continuation flows back through the SAME stream — no new request, no reload.
//
// This is the cloud twin of desktop's services/interaction.ts. Mobile has no local sidecar
// engine (手机端 = 桌面端 − 本地能力层), so unlike desktop there is no sidecar branch —
// every turn is a cloud turn.
import type {
  ApprovalDecision,
  CheckpointDecision,
} from "@agentcore/contract-types";

/**
 * The user's settlement of a paused interaction, discriminated on `kind` — mirrors the
 * backend ResolveInteractionRequest union (schemas.py).
 *
 * NOTE the wire `kind` for a checkpoint is `ask_user` (the fold's PendingInteraction calls
 * it `checkpoint`; the endpoint discriminates on the backend's `ask_user`). For `ask_user`
 * the user's answer rides in `note` on a `continue` too (the only reader is the CEO — see
 * ask_user_tool_result); for `plan_review`, `note` is used only as an `adjust` steer onto
 * the not-yet-run downstream nodes.
 */
export type ResolveInteractionBody =
  | { kind: "approval"; decision: ApprovalDecision }
  | {
      kind: "ask_user";
      decision: CheckpointDecision;
      note: string;
      selected: string[];
    }
  | { kind: "plan_review"; decision: CheckpointDecision; note: string };

/**
 * POST a paused interaction's answer; the awaiter in the live `streamMessage` SSE resumes
 * and the turn continues on the same stream. A 404 means the interaction is stale (timed
 * out, already settled, or the turn ended) — swallowed as a no-op (the stream's terminal /
 * *_resolved event settles the UI anyway, mirroring desktop). Any other failure throws so
 * the caller can re-enable the card for a retry.
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
