// Turn-lifecycle JSON endpoints for the mobile client (执行与请求解耦 C1 / 结构化挂起 2b).
//
// These are the plain-JSON companions to the SSE channels in stream.ts:
//   - stopConversation  → explicitly cancel an in-flight detached run (the 停止 button)
//   - listPausedTurns   → durably-paused turns awaiting resume, surfaced on reopen
// The resume itself is SSE (stream.ts::resumeStream). Types are a hand-written subset of
// the backend schema (schemas.py), matching the skeleton convention in conversations.ts.
import { apiFetch } from "@/api/client";

/**
 * Explicitly stop the conversation's in-flight turn (执行与请求解耦 C1 · slice 1a).
 *
 * A client disconnect no longer cancels a server turn — it runs detached and persists
 * (so a long turn survives a dropped connection). The 停止 button must therefore ask
 * the server to cancel the detached run; aborting the local fetch alone would leave it
 * running and billing. Best-effort + idempotent: returns whether a live run was actually
 * signalled (false when nothing was running); a failed call is swallowed (worst case the
 * turn finishes server-side and is saved, never a stuck UI). The caller need not await.
 */
export async function stopConversation(
  conversationId: string,
): Promise<boolean> {
  try {
    const res = await apiFetch(`/v1/conversations/${conversationId}/stop`, {
      method: "POST",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { stopped: boolean };
    return data.stopped;
  } catch {
    return false;
  }
}

/** A turn paused at a plan_review / ask_user checkpoint whose live stream was lost
 *  (disconnect / restart) — only a persisted frame survives. `message_id` is both the
 *  pause key and the id the resumed assistant message reuses. The `steps`/`pending`
 *  (plan_review) and `question`/`context`/… (ask_user) sets are mutually exclusive. */
export type SuspensionKind = "plan_review" | "ask_user";

export interface PausedTurnSummary {
  message_id: string;
  kind: SuspensionKind;
  checkpoint_id: string;
  user_message: string;
  // plan_review (empty on an ask_user frame)
  steps: Array<Record<string, unknown>>;
  pending: Array<Record<string, unknown>>;
  // ask_user (empty on a plan_review frame)
  question: string;
  context: string;
  assumptions: string[];
  questions: string[];
  style_options: string[];
}

/**
 * List a conversation's durably-paused turns awaiting resume (结构化挂起 2b). Called on
 * reopen so a turn that paused then lost its stream surfaces a resume card above the
 * composer. Oldest-first; an empty list when nothing is paused.
 */
export async function listPausedTurns(
  conversationId: string,
): Promise<PausedTurnSummary[]> {
  const res = await apiFetch(`/v1/conversations/${conversationId}/paused`);
  if (!res.ok) throw new Error(`加载挂起回合失败 (${res.status})`);
  const data = (await res.json()) as { data: PausedTurnSummary[] };
  return data.data ?? [];
}
