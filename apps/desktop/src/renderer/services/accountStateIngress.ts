import { parseResumeSettledPayload } from "@/lib/resumeSettled";
import { type FulfillFrame, onFulfillFrame } from "@/services/fulfillStream";
import { useInteractionStore } from "@/stores/interactions";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import {
  type QueuedTurnEntry,
  useQueuedTurnsStore,
} from "@/stores/queuedTurns";

/**
 * 账号级状态帧 → 本地 store（设备长连接 `GET /v1/fulfill`）。
 *
 * 对话级订阅同时只留一条（每访问一个会话就多挂一条空闲 SSE 会吃光连接池），所以
 * 「另一个会话里发生的事」在本端没有任何显示流可走：队列是账号的，挂起卡也是账号的，
 * 它们在哪个对话里变化与用户此刻在看哪个对话无关。设备长连接正是按账号开、每台在线
 * 桌面一条的那条通道，这些状态就走它。
 *
 * 帧带的是**事实全量**（整条队列、结算后的卡面），不是「变了」信号——本端不再回头拉
 * 任何东西。此前那三个对账模块（切会话 / 订阅重连时猜「可能漏了」再 GET）就此没有
 * 存在的理由。
 *
 * 只订云通道：sidecar 的履约推送是本机引擎在回合内发的 op 帧，不带账号态。
 */

let unsubscribe: (() => void) | null = null;

function applyQueueSnapshot(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as { conversation_id?: unknown; items?: unknown };
  const conversationId =
    typeof p.conversation_id === "string" ? p.conversation_id : "";
  if (!conversationId || !Array.isArray(p.items)) return;

  const store = useQueuedTurnsStore.getState();
  const prevById = new Map(
    store.list(conversationId).map((e) => [e.queueId, e]),
  );
  const depth = p.items.length;
  const next: QueuedTurnEntry[] = [];
  for (const raw of p.items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const queueId = typeof item.queue_id === "string" ? item.queue_id : "";
    if (!queueId) continue;
    const prev = prevById.get(queueId);
    const interjectionId =
      typeof item.interjection_id === "string"
        ? item.interjection_id.trim() || undefined
        : undefined;
    next.push({
      queueId,
      conversationId,
      content: typeof item.content === "string" ? item.content : "",
      position:
        typeof item.position === "number" ? item.position : next.length + 1,
      queueDepth: depth,
      interjectionId,
      // 出队插泡竞态：同 queue_id 仍在队时保留本地 messageId / degradedFrom。
      messageId: prev?.messageId,
      degradedFrom: prev?.degradedFrom,
    });
  }
  store.replaceConversation(conversationId, next);
}

function applyPausedCardSettled(payload: unknown): void {
  const p = parseResumeSettledPayload(payload);
  if (!p) return;
  // 卡收成结果态（决策 + 落定时刻），壳一并丢掉——这帧就是「帧不在了」的证据。
  // 不碰气泡流：本端若正跟着那个对话，收口由它自己的回合流负责。
  useInteractionStore.getState().markResumeSettled({
    id: p.checkpoint_id,
    kind: p.kind,
    conversationId: p.conversation_id,
    messageId: p.message_id,
    decision: p.decision,
    decidedAt: p.decided_at,
    turnStatus: p.turn_status,
  });
  usePausedTurnStore.getState().removeByCheckpoint(p.checkpoint_id);
}

function onFrame(frame: FulfillFrame): void {
  if (frame.type === "turn_queue_snapshot") {
    applyQueueSnapshot(frame.payload);
    return;
  }
  if (frame.type === "paused_card_settled") {
    applyPausedCardSettled(frame.payload);
  }
}

/** Subscribe once for the renderer lifetime (idempotent). Call from `main.tsx`. */
export function installAccountStateIngress(): void {
  if (unsubscribe) return;
  unsubscribe = onFulfillFrame(onFrame);
}

/** Test-only: drop the subscription. */
export function resetAccountStateIngressForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
}
