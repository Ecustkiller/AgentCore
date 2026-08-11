/**
 * 会话排队条对账：GET 快照为权威，替换本地 FIFO。
 * 时机由调用方决定（开会话 / SSE 重连 / turn_queued 缺本地项）；禁轮询。
 */
import { fetchQueuedTurns } from "@/api/turn";
import {
  type QueuedTurnSnapshotItem,
  applyQueuedTurnsSnapshot,
} from "@/lib/queuedTurns";

export const QUEUE_DROPPED_HINT = "有排队项已失效（可能因服务端重启）";

export type ReconcileQueuedTurnsResult = {
  droppedLocalIds: string[];
  /** 对账失败（网络等）时 true；本地条不变。 */
  failed?: boolean;
};

/**
 * 拉取服务端 FIFO 并替换本地。失败 best-effort（不抛、不改本地）。
 */
export async function reconcileQueuedTurns(
  conversationId: string,
  fetch: (
    conversationId: string,
  ) => Promise<QueuedTurnSnapshotItem[]> = fetchQueuedTurns,
): Promise<ReconcileQueuedTurnsResult> {
  try {
    const items = await fetch(conversationId);
    return applyQueuedTurnsSnapshot(conversationId, items);
  } catch {
    return { droppedLocalIds: [], failed: true };
  }
}
