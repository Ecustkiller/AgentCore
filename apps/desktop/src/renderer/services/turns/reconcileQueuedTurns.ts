import { notifyInfo } from "@/lib/toast";
import { api } from "@/services/api";
import {
  type QueuedTurnEntry,
  useQueuedTurnsStore,
} from "@/stores/queuedTurns";
import type { components } from "@/types/api.generated";

type QueuedTurnListResponse = components["schemas"]["QueuedTurnListResponse"];

/** 同会话并发对账合并为一次 GET（开会话 + attach + 缺 id 信号可能叠发）。 */
const inflight = new Map<string, Promise<void>>();

/**
 * 用 ``GET …/queued-turns`` 快照替换本会话 FIFO 条（权威内容源）。
 * EPHEMERAL ``turn_queued`` / ``turn_queue_started`` / ``turn_queue_cancelled``
 * 只作「变了」信号；本函数是内容权威与冷开 / 重连 / 多端 / 升队兜底。
 *
 * 本地有项而服务端已无该项 → 一次轻提示后清掉（进程内队列；重启丢队）。
 * 失败吞掉（best-effort，不挡会话打开）。
 */
export function reconcileQueuedTurns(conversationId: string): Promise<void> {
  const existing = inflight.get(conversationId);
  if (existing) return existing;
  const run = doReconcile(conversationId).finally(() => {
    if (inflight.get(conversationId) === run) inflight.delete(conversationId);
  });
  inflight.set(conversationId, run);
  return run;
}

/** 测试用：清并发合并表。 */
export function resetReconcileQueuedTurnsInflightForTests(): void {
  inflight.clear();
}

async function doReconcile(conversationId: string): Promise<void> {
  let items: components["schemas"]["QueuedTurnItem"][] = [];
  try {
    const res = await api.get<QueuedTurnListResponse>(
      `/v1/conversations/${conversationId}/queued-turns`,
    );
    items = res.items ?? [];
  } catch {
    return;
  }

  const local = useQueuedTurnsStore.getState().list(conversationId);
  const serverIds = new Set(items.map((it) => it.queue_id));
  const droppedLocal = local.some((e) => !serverIds.has(e.queueId));
  if (droppedLocal) {
    notifyInfo("排队已失效：服务重启后队列不会保留");
  }

  const depth = items.length;
  const prevById = new Map(local.map((e) => [e.queueId, e]));
  const next: QueuedTurnEntry[] = items.map((it) => {
    const prev = prevById.get(it.queue_id);
    const interjectionId = (it.interjection_id ?? "").trim() || undefined;
    return {
      queueId: it.queue_id,
      conversationId,
      content: it.content,
      position: it.position,
      queueDepth: depth,
      interjectionId,
      // 出队插泡竞态：同 queue_id 仍在队时保留本地 messageId / degradedFrom。
      messageId: prev?.messageId,
      degradedFrom: prev?.degradedFrom,
    };
  });

  useQueuedTurnsStore.getState().replaceConversation(conversationId, next);
}
