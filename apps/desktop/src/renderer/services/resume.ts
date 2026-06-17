import { api } from "@/services/api";
import { resolveSidecarRoot } from "@/services/sidecarRouting";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import type { components } from "@/types/api.generated";

type PausedTurnListResponse = components["schemas"]["PausedTurnListResponse"];
type PausedTurnSummary = components["schemas"]["PausedTurnSummary"];

/** List a conversation's durably-paused turns awaiting resume (结构化挂起 2b). */
export async function listPausedTurns(
  conversationId: string,
): Promise<PausedTurnSummary[]> {
  const res = await api.get<PausedTurnListResponse>(
    `/v1/conversations/${conversationId}/paused`,
  );
  return res.data ?? [];
}

/**
 * Fetch a conversation's paused turns into the store (best-effort).
 *
 * Called on conversation reopen so a turn that paused at a plan_review / ask_user
 * checkpoint then lost its stream surfaces a resume card above the composer. Routed
 * like a send (双模式工作区 §一.1): a conversation bound to a present local root reads
 * its **local** frame files via the sidecar bridge (no Python spawn — a read-only
 * list); else the cloud. A sidecar summary is the same shape as the cloud one, so the
 * store ingests it unchanged. A lookup failure is swallowed — it must never block
 * opening a conversation (the turn stays recoverable on a later reopen).
 */
export async function loadPausedTurns(conversationId: string): Promise<void> {
  try {
    // listPaused 读本机帧文件、按会话过滤（不拉起 Python、与子路径无关），故只需容器根 id。
    const sidecarTarget = await resolveSidecarRoot(conversationId);
    const data = sidecarTarget
      ? ((await window.sidecarApi.listPaused({
          rootId: sidecarTarget.rootId,
          conversationId,
        })) as unknown as PausedTurnSummary[])
      : await listPausedTurns(conversationId);
    usePausedTurnStore.getState().setForConversation(conversationId, data);
  } catch {
    /* best-effort: never block reopening on a paused-turn lookup */
  }
}
