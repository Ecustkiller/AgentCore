// Turn-lifecycle JSON endpoints for the mobile client (执行与请求解耦 C1 / 结构化挂起 2b).
//
// Plain-JSON companions to the SSE channels in stream.ts:
//   - stopConversation  → explicitly cancel an in-flight detached run
//   - listPausedTurns   → durably-paused turns awaiting resume
// The resume itself is SSE (stream.ts::resumeStream). REST DTOs track OpenAPI.
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

export type SuspensionKind = Schemas["SuspensionKind"];
export type PausedTurnSummary = Schemas["PausedTurnSummary"];

type StopTurnResponse = Schemas["StopTurnResponse"];
type PausedTurnListResponse = Schemas["PausedTurnListResponse"];

/**
 * Explicitly stop the conversation's in-flight turn (执行与请求解耦 C1 · slice 1a).
 *
 * Best-effort + idempotent: returns whether a live run was actually signalled.
 */
export async function stopConversation(
  conversationId: string,
): Promise<boolean> {
  try {
    const res = await apiFetch(`/v1/conversations/${conversationId}/stop`, {
      method: "POST",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as StopTurnResponse;
    return data.stopped;
  } catch {
    return false;
  }
}

/**
 * List a conversation's durably-paused turns awaiting resume (结构化挂起 2b).
 * Oldest-first; an empty list when nothing is paused.
 */
export async function listPausedTurns(
  conversationId: string,
): Promise<PausedTurnSummary[]> {
  const res = await apiFetch(`/v1/conversations/${conversationId}/paused`);
  if (!res.ok) throw new Error(`加载挂起回合失败 (${res.status})`);
  const data = (await res.json()) as PausedTurnListResponse;
  return data.data ?? [];
}
