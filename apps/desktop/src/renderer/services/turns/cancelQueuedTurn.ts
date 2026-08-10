import { ApiError, api } from "@/services/api";
import { useConversationStore } from "@/stores/conversation";
import {
  type QueuedTurnEntry,
  useQueuedTurnsStore,
} from "@/stores/queuedTurns";

/**
 * 本地清排队条（幂等）。有关联 messageId 时顺带删泡；无泡则只清条。
 * HTTP 取消成功 / 404、以及 SSE ``turn_queue_cancelled`` 共用。
 */
export function clearQueuedTurnLocally(
  conversationId: string,
  queueId: string,
): QueuedTurnEntry | null {
  const removed = useQueuedTurnsStore
    .getState()
    .remove(conversationId, queueId);
  if (removed?.messageId) {
    useConversationStore
      .getState()
      .removeMessage(removed.messageId, conversationId);
  }
  return removed;
}

/**
 * 按项取消 FIFO 排队（``POST …/queued-turns/{queue_id}/cancel``）。
 * 成功或 404（已不在队）→ 立刻本地清条，不依赖 live ``turn_queue_cancelled``
 * （Stop 后常无该事件）。SSE 仍作多端同步（幂等清）。
 * Stop ≠ 取消排队。取消入口仅 QueuedTurnsBar。
 */
export async function cancelQueuedTurn(
  conversationId: string,
  queueId: string,
): Promise<void> {
  try {
    await api.post(
      `/v1/conversations/${conversationId}/queued-turns/${queueId}/cancel`,
      {},
    );
    clearQueuedTurnLocally(conversationId, queueId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      clearQueuedTurnLocally(conversationId, queueId);
      return;
    }
    throw err;
  }
}
