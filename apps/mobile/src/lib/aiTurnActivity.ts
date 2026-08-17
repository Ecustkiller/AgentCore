/**
 * 「哪些云对话还在跑」——账号级 fulfill 信号 `ai_turn_activity_snapshot` /
 * `ai_turn_activity`（设备长连接 `GET /v1/fulfill`，手机只当 observer）。
 *
 * 对话级 SSE 同时只留一条，所以另一条对话在跑时本端没有任何显示流可走。设备通道按账号
 * 开、每个在线端一条，连接时播种整份 running 集合（客户端 replace），之后按对话增量
 * 进出。帧带的是事实，不回头 GET；断线靠下一帧 snapshot 整表替换，禁止「打开即清」。
 *
 * 本机容器对话不吃这路云信号——`local_container_root_id` 有值则以本端生成为准，
 * 否则同一条对话会被云 running 与本机流各点一次灯。本轮不记 lastDone、不弹完成 Toast。
 */
import { useCallback, useSyncExternalStore } from "react";

export const AI_TURN_ACTIVITY_SNAPSHOT_TYPE = "ai_turn_activity_snapshot";
export const AI_TURN_ACTIVITY_TYPE = "ai_turn_activity";

let running = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setRunning(next: Set<string>): void {
  running = next;
  emit();
}

function asIdList(raw: unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function sameIds(current: ReadonlySet<string>, ids: string[]): boolean {
  if (current.size !== ids.length) return false;
  for (const id of ids) {
    if (!current.has(id)) return false;
  }
  return true;
}

function replaceRunning(ids: string[]): void {
  if (sameIds(running, ids)) return;
  setRunning(new Set(ids));
}

function applyActivity(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as {
    conversation_id?: unknown;
    state?: unknown;
  };
  const conversationId =
    typeof p.conversation_id === "string" ? p.conversation_id : "";
  if (!conversationId) return;

  if (p.state === "running") {
    if (running.has(conversationId)) return;
    const next = new Set(running);
    next.add(conversationId);
    setRunning(next);
    return;
  }

  if (p.state !== "done") return;
  if (!running.has(conversationId)) return;
  const next = new Set(running);
  next.delete(conversationId);
  setRunning(next);
}

/** 连接播种：整份 `{ running }` replace。缺字段 / 非数组的帧丢掉，不清现有集合。 */
export function applyAiTurnActivitySnapshot(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const raw = (payload as { running?: unknown }).running;
  if (!Array.isArray(raw)) return;
  replaceRunning(asIdList(raw));
}

/** 增量：`{ conversation_id, state }`。running 进、done 出；本轮不认 reason。 */
export function applyAiTurnActivity(payload: unknown): void {
  applyActivity(payload);
}

/** 清空——running 是会话内的东西，登出即作废。 */
export function clearAiTurnActivity(): void {
  if (running.size === 0) return;
  setRunning(new Set());
}

export function getAiTurnActivityRunning(): readonly string[] {
  return [...running];
}

export function subscribeAiTurnActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 本机容器对话不吃云 running。手机没有 sidecar；只认 `local_container_root_id`。
 */
export function ignoresCloudTurnActivity(
  localContainerRootId?: string | null,
): boolean {
  return localContainerRootId != null;
}

export function conversationCloudRunning(
  conversationId: string,
  localContainerRootId?: string | null,
): boolean {
  if (ignoresCloudTurnActivity(localContainerRootId)) return false;
  return running.has(conversationId);
}

export function useConversationCloudRunning(
  conversationId: string,
  localContainerRootId?: string | null,
): boolean {
  const snapshot = useCallback(
    () => conversationCloudRunning(conversationId, localContainerRootId),
    [conversationId, localContainerRootId],
  );
  return useSyncExternalStore(subscribeAiTurnActivity, snapshot, snapshot);
}

export function __resetAiTurnActivityForTests(): void {
  clearAiTurnActivity();
}
