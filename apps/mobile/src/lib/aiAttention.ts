/**
 * 「某个对话在等你」跨对话提醒（firehose `ai_attention`）。
 *
 * 回合停下来等人拍板时后端往 `/v1/realtime` 发 `required`，放行后发 `resolved`。这里只
 * 记「哪些对话在等」，让用户人不在那个对话页也能看见；对话页内真正的可操作面仍是
 * ResumeCard / PauseCard，由该页自己的 recovery 快照定权威，本存储不参与。
 *
 * 没有跨对话的挂起快照接口，所以断线期间漏掉的 `resolved` 补不回来——由「打开该对话即清」
 * 兜底（{@link clearAiAttentionForConversation}），提示条因此永远有一键退出。
 */
import { useCallback, useSyncExternalStore } from "react";

/** `/v1/realtime` 的 `ai_attention` 帧（扁平事件对象，不是 turn 流的 envelope）。 */
export interface AiAttentionEvent {
  type: "ai_attention";
  state: "required" | "resolved";
  conversation_id: string;
  turn_id: string;
  interaction_id: string;
  kind: string;
  title: string;
}

export interface AiAttentionEntry {
  interactionId: string;
  conversationId: string;
  turnId: string;
  kind: string;
  title: string;
}

let entries: readonly AiAttentionEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setEntries(next: readonly AiAttentionEntry[]): void {
  entries = next;
  emit();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 应用一帧 `ai_attention`；字段缺失的帧直接丢弃。 */
export function applyAiAttention(event: AiAttentionEvent): void {
  const interactionId = text(event.interaction_id);
  const conversationId = text(event.conversation_id);
  if (!interactionId || !conversationId) return;

  if (event.state === "resolved") {
    const next = entries.filter((e) => e.interactionId !== interactionId);
    if (next.length !== entries.length) setEntries(next);
    return;
  }
  if (event.state !== "required") return;

  const entry: AiAttentionEntry = {
    interactionId,
    conversationId,
    turnId: text(event.turn_id),
    kind: text(event.kind),
    title: text(event.title),
  };
  const index = entries.findIndex((e) => e.interactionId === interactionId);
  if (index < 0) {
    setEntries([...entries, entry]);
    return;
  }
  // 同一 interaction 重发（多端 / 重连补发）：更新文案但留在原位，提示条不跳序。
  const next = entries.slice();
  next[index] = entry;
  setEntries(next);
}

/** 打开某对话即清它的提醒——该页自己会呈现真正的卡片，也兜住漏收的 `resolved`。 */
export function clearAiAttentionForConversation(conversationId: string): void {
  if (!conversationId) return;
  const next = entries.filter((e) => e.conversationId !== conversationId);
  if (next.length !== entries.length) setEntries(next);
}

/** 清空——提醒是会话内的东西，登出即作废。 */
export function clearAiAttention(): void {
  if (entries.length > 0) setEntries([]);
}

export function getAiAttentionSnapshot(): readonly AiAttentionEntry[] {
  return entries;
}

export function subscribeAiAttention(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook —— 等待中的对话列表，按到达先后排序。 */
export function useAiAttention(): readonly AiAttentionEntry[] {
  return useSyncExternalStore(
    subscribeAiAttention,
    getAiAttentionSnapshot,
    getAiAttentionSnapshot,
  );
}

/**
 * 该对话是否正停着等人——会话列表行的「等你」灯。
 *
 * 一个对话可能同时挂着多条 entry（按 interaction 存），行上只有一颗灯，所以在这里按
 * conversationId 归并成一个布尔；返回原始值，`useSyncExternalStore` 才不会因为每次算出
 * 新数组而反复重渲。
 */
export function useConversationAwaitingAttention(
  conversationId: string,
): boolean {
  const snapshot = useCallback(
    () => entries.some((e) => e.conversationId === conversationId),
    [conversationId],
  );
  return useSyncExternalStore(subscribeAiAttention, snapshot, snapshot);
}

export function __resetAiAttentionForTests(): void {
  clearAiAttention();
}
