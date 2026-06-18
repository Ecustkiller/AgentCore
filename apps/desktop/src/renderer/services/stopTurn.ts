import { api } from "@/services/api";

/**
 * Ask the backend to stop a conversation's in-flight turn (执行与请求解耦 C1 · slice 1a).
 *
 * A client disconnect no longer cancels a server turn — it finishes and persists
 * in the background (so a long turn is never lost to a dropped connection, 案例 1).
 * The 停止 button therefore must explicitly ask the server to cancel the detached
 * run; aborting the local fetch alone would leave it running and billing.
 *
 * Best-effort: the UI has already aborted the local stream and settled the bubble,
 * so a failed stop call is swallowed — the worst case is the turn finishing
 * server-side and being saved, never a stuck UI. Returns whether a live run was
 * actually signalled (false when nothing was running, e.g. a sidecar/local turn or
 * an already-finished one). The caller need not await it.
 */
export async function stopConversation(
  conversationId: string,
): Promise<boolean> {
  try {
    const res = await api.post<{ stopped: boolean }>(
      `/v1/conversations/${conversationId}/stop`,
    );
    return res.stopped;
  } catch {
    return false;
  }
}
