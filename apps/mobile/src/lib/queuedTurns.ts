/**
 * 同对话 FIFO 排队项（live；进程内）。
 * 内容权威 = GET `/queued-turns`；EPHEMERAL `turn_queued` / `started` / `cancelled` 只作「变了」信号。
 * 发送路径可本地即时 upsert；对账替换为权威修正。
 * 产品语义：排队期仅 QueuedTurnsBar；出队开跑再进主时间线用户泡并清条；取消只清条。
 */
import { useSyncExternalStore } from "react";

export interface QueuedTurnEntry {
  queueId: string;
  conversationId: string;
  content: string;
  position: number;
  queueDepth: number;
  degradedFrom?: "steer";
  /** 由用户插话升格进队时非空（协调升队 / 经典 leftover）。 */
  interjectionId?: string;
}

/** GET 快照项（camelCase；由 api 层映射）。 */
export type QueuedTurnSnapshotItem = {
  queueId: string;
  content: string;
  position: number;
  interjectionId?: string | null;
};

type Listener = () => void;

let byConversation: Record<string, QueuedTurnEntry[]> = {};
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Record<string, QueuedTurnEntry[]> {
  return byConversation;
}

export function upsertQueuedTurn(entry: QueuedTurnEntry): void {
  const prev = byConversation[entry.conversationId] ?? [];
  const without = prev.filter((e) => e.queueId !== entry.queueId);
  byConversation = {
    ...byConversation,
    [entry.conversationId]: [...without, entry].sort(
      (a, b) => a.position - b.position,
    ),
  };
  emit();
}

export function removeQueuedTurn(
  conversationId: string,
  queueId: string,
): QueuedTurnEntry | null {
  const prev = byConversation[conversationId] ?? [];
  const hit = prev.find((e) => e.queueId === queueId) ?? null;
  if (!hit) return null;
  const next = prev.filter((e) => e.queueId !== queueId);
  const copy = { ...byConversation };
  if (next.length === 0) delete copy[conversationId];
  else copy[conversationId] = next;
  byConversation = copy;
  emit();
  return hit;
}

export function clearQueuedTurns(conversationId: string): void {
  if (!byConversation[conversationId]) return;
  const copy = { ...byConversation };
  delete copy[conversationId];
  byConversation = copy;
  emit();
}

export function listQueuedTurns(
  conversationId: string | null | undefined,
): QueuedTurnEntry[] {
  return conversationId ? (byConversation[conversationId] ?? []) : [];
}

/** 将服务端快照映射为本地条（queueDepth = 快照长度）。 */
export function queuedEntriesFromSnapshot(
  conversationId: string,
  items: QueuedTurnSnapshotItem[],
): QueuedTurnEntry[] {
  const depth = items.length;
  const prevById = new Map(
    (byConversation[conversationId] ?? []).map((e) => [e.queueId, e]),
  );
  return items
    .map((item) => {
      const interjectionId = (item.interjectionId ?? "").trim() || undefined;
      const prev = prevById.get(item.queueId);
      return {
        queueId: item.queueId,
        conversationId,
        content: item.content,
        position: item.position,
        queueDepth: depth,
        interjectionId,
        // GET 无 degraded_from；同 queue_id 保留发送路径写入的诚实标注。
        degradedFrom: prev?.degradedFrom,
      } satisfies QueuedTurnEntry;
    })
    .sort((a, b) => a.position - b.position);
}

/**
 * 用服务端快照整表替换本地条。
 * 返回：对账前本地有、服务端已无的 queueId（重启丢队等）。
 */
export function applyQueuedTurnsSnapshot(
  conversationId: string,
  items: QueuedTurnSnapshotItem[],
): { droppedLocalIds: string[] } {
  const prev = byConversation[conversationId] ?? [];
  const serverIds = new Set(items.map((i) => i.queueId));
  const droppedLocalIds = prev
    .filter((e) => !serverIds.has(e.queueId))
    .map((e) => e.queueId);

  const next = queuedEntriesFromSnapshot(conversationId, items);
  const copy = { ...byConversation };
  if (next.length === 0) delete copy[conversationId];
  else copy[conversationId] = next;
  byConversation = copy;
  emit();
  return { droppedLocalIds };
}

/** 整表替换（测试 / 直接写入）；不计算 dropped。 */
export function replaceQueuedTurns(
  conversationId: string,
  entries: QueuedTurnEntry[],
): void {
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  const copy = { ...byConversation };
  if (sorted.length === 0) delete copy[conversationId];
  else copy[conversationId] = sorted;
  byConversation = copy;
  emit();
}

const EMPTY: QueuedTurnEntry[] = [];

/** React 订阅：同对话 FIFO 排队项。 */
export function useQueuedTurns(
  conversationId: string | null | undefined,
): QueuedTurnEntry[] {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!conversationId) return EMPTY;
  return snap[conversationId] ?? EMPTY;
}

/** 测试用：重置全部排队态。 */
export function __resetQueuedTurnsForTests(): void {
  byConversation = {};
  emit();
}
