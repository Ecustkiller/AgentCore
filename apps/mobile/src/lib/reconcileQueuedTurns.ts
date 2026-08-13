/**
 * 会话排队条对账：GET 快照为权威，替换本地 FIFO。
 * 时机由调用方决定（开会话 / SSE 重连 / 收到队列类信号）；禁轮询。
 *
 * 多端同权（B2 · P1）后触发源变多——另一端 Queue / 取消 / 出队都会来一发，所以这里要能扛
 * 并发：① 只让最后一次发起的对账落地（乱序回来的旧快照不许盖新的）；② 快照只对它拉取的那
 * 一刻负责，拉取期间本端新排进去的项不算「已失效」。
 */
import { fetchQueuedTurns } from "@/api/turn";
import {
  type QueuedTurnSnapshotItem,
  applyQueuedTurnsSnapshot,
  listQueuedTurns,
} from "@/lib/queuedTurns";

export const QUEUE_DROPPED_HINT = "有排队项已失效（可能因服务端重启）";

export type ReconcileQueuedTurnsResult = {
  droppedLocalIds: string[];
  /** 对账失败（网络等）时 true；本地条不变。 */
  failed?: boolean;
  /** 期间又发起了更新的一次对账，本次结果作废（本地条交给那一次）。 */
  superseded?: boolean;
};

/** 每对话的对账代号——只有最后发起的那次可以落地。 */
const generations = new Map<string, number>();

/**
 * 拉取服务端 FIFO 并替换本地。失败 best-effort（不抛、不改本地）。
 */
export async function reconcileQueuedTurns(
  conversationId: string,
  fetch: (
    conversationId: string,
  ) => Promise<QueuedTurnSnapshotItem[]> = fetchQueuedTurns,
): Promise<ReconcileQueuedTurnsResult> {
  const gen = (generations.get(conversationId) ?? 0) + 1;
  generations.set(conversationId, gen);
  const knownBefore = new Set(
    listQueuedTurns(conversationId).map((e) => e.queueId),
  );
  let items: QueuedTurnSnapshotItem[];
  try {
    items = await fetch(conversationId);
  } catch {
    return { droppedLocalIds: [], failed: true };
  }
  if (generations.get(conversationId) !== gen) {
    return { droppedLocalIds: [], superseded: true };
  }
  const serverIds = new Set(items.map((i) => i.queueId));
  // 拉取期间本端刚排进去的项：这份快照根本没看见过它们，不是「失效」。
  const arrivedDuringFetch = listQueuedTurns(conversationId)
    .filter((e) => !knownBefore.has(e.queueId) && !serverIds.has(e.queueId))
    .map(
      (e): QueuedTurnSnapshotItem => ({
        queueId: e.queueId,
        content: e.content,
        position: e.position,
        interjectionId: e.interjectionId ?? null,
      }),
    );
  return applyQueuedTurnsSnapshot(conversationId, [
    ...items,
    ...arrivedDuringFetch,
  ]);
}

/** 测试用：清掉对账代号，免得跨用例互相作废。 */
export function __resetReconcileGenerationsForTests(): void {
  generations.clear();
}
