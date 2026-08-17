/**
 * 手机对话列表进程内缓存——抽屉开着时跟铸题和位次。
 *
 * 铸题只改 title，不写 `updated_at`（不顶位次）。位次跟 `updated_at`：
 * 对话流 `message_start`、以及 fulfill `ai_turn_activity` 的 running 帧才 bump。
 * 行不在缓存里一律 no-op，不凭事件臆造一行。不共享桌面 react-query。
 */
import type {
  ConversationSummary,
  GroupedConversations,
} from "@/api/conversations";
import { useSyncExternalStore } from "react";

export type ConversationListTitlePatch = {
  title?: string | null;
  pinned?: boolean;
};

let grouped: GroupedConversations | null = null;
let archived: ConversationSummary[] | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function mapGrouped(
  current: GroupedConversations,
  fn: (c: ConversationSummary) => ConversationSummary | null,
): GroupedConversations {
  const apply = (rows: ConversationSummary[]) =>
    rows.flatMap((c) => {
      const next = fn(c);
      return next ? [next] : [];
    });
  return {
    folders: current.folders.map((f) => ({
      ...f,
      conversations: apply(f.conversations),
    })),
    ungrouped: apply(current.ungrouped),
  };
}

function insertRestoredIntoGrouped(
  current: GroupedConversations,
  restored: ConversationSummary,
): GroupedConversations {
  const without = mapGrouped(current, (x) => (x.id === restored.id ? null : x));
  const folderId = restored.folder_id;
  if (folderId && without.folders.some((f) => f.id === folderId)) {
    return {
      folders: without.folders.map((f) =>
        f.id === folderId
          ? { ...f, conversations: [restored, ...f.conversations] }
          : f,
      ),
      ungrouped: without.ungrouped,
    };
  }
  return {
    folders: without.folders,
    ungrouped: [restored, ...without.ungrouped],
  };
}

function updateById(
  id: string,
  fn: (c: ConversationSummary) => ConversationSummary,
): boolean {
  let changed = false;
  if (grouped) {
    let side = false;
    const next = mapGrouped(grouped, (c) => {
      if (c.id !== id) return c;
      const mapped = fn(c);
      if (mapped !== c) side = true;
      return mapped;
    });
    if (side) {
      grouped = next;
      changed = true;
    }
  }
  if (archived) {
    let side = false;
    const next = archived.map((c) => {
      if (c.id !== id) return c;
      const mapped = fn(c);
      if (mapped !== c) side = true;
      return mapped;
    });
    if (side) {
      archived = next;
      changed = true;
    }
  }
  return changed;
}

function payloadTitle(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const title = (payload as { title?: unknown }).title;
  return typeof title === "string" ? title : null;
}

/** 直播列表快照；未 replace 过为 null。 */
export function getConversationListGrouped(): GroupedConversations | null {
  return grouped;
}

/** 归档列表快照；未 replace 过为 null。 */
export function getConversationListArchived(): ConversationSummary[] | null {
  return archived;
}

export function subscribeConversationList(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function replaceGrouped(next: GroupedConversations | null): void {
  if (grouped === next) return;
  grouped = next;
  emit();
}

export function replaceArchived(next: ConversationSummary[] | null): void {
  if (archived === next) return;
  archived = next;
  emit();
}

/** 按 id 改 title / pinned；不写 `updated_at`。无该行则 no-op。 */
export function patchConversation(
  id: string,
  patch: ConversationListTitlePatch,
): void {
  if (!id) return;
  const changed = updateById(id, (c) => {
    const title = patch.title !== undefined ? patch.title : c.title;
    const pinned = patch.pinned !== undefined ? patch.pinned : c.pinned;
    if (title === c.title && pinned === c.pinned) return c;
    return { ...c, title, pinned };
  });
  if (changed) emit();
}

/** 从 grouped / 归档里去掉该行。无该行则 no-op。 */
export function removeConversation(id: string): void {
  if (!id) return;
  let changed = false;
  if (grouped) {
    let side = false;
    const next = mapGrouped(grouped, (c) => {
      if (c.id !== id) return c;
      side = true;
      return null;
    });
    if (side) {
      grouped = next;
      changed = true;
    }
  }
  if (archived) {
    const next = archived.filter((c) => c.id !== id);
    if (next.length !== archived.length) {
      archived = next;
      changed = true;
    }
  }
  if (changed) emit();
}

/**
 * 软删恢复：按 `folder_id` 插回 grouped（`pinned` 留给 rail 重切）。
 * 找不到组则进裸聊。grouped 仍为 null 时 no-op。
 */
export function insertRestored(restored: ConversationSummary): void {
  if (!grouped) return;
  grouped = insertRestoredIntoGrouped(grouped, restored);
  emit();
}

/** 铸题：只改 title，不顶位次。无该行则 no-op。 */
export function applyTitle(id: string, title: string): void {
  if (!id) return;
  const changed = updateById(id, (c) =>
    c.title === title ? c : { ...c, title },
  );
  if (changed) emit();
}

/** 位次：`updated_at = now`。行须已在缓存里，否则 no-op。 */
export function bumpActivity(id: string): void {
  if (!id) return;
  const now = new Date().toISOString();
  const changed = updateById(id, (c) =>
    c.updated_at === now ? c : { ...c, updated_at: now },
  );
  if (changed) emit();
}

/**
 * 对话流事件入口。`title_generated` 用 payload.title 铸题；
 * `message_start` 才 bump。其它事件 / 无该行一律 no-op。
 */
export function noteConversationStreamEvent(
  conversationId: string,
  event: { type?: string; payload?: unknown },
): void {
  if (!conversationId) return;
  if (event.type === "title_generated") {
    const title = payloadTitle(event.payload);
    if (title == null) return;
    applyTitle(conversationId, title);
    return;
  }
  if (event.type === "message_start") {
    bumpActivity(conversationId);
  }
}

export function useConversationListGrouped(): GroupedConversations | null {
  return useSyncExternalStore(
    subscribeConversationList,
    getConversationListGrouped,
    getConversationListGrouped,
  );
}

export function useConversationListArchived(): ConversationSummary[] | null {
  return useSyncExternalStore(
    subscribeConversationList,
    getConversationListArchived,
    getConversationListArchived,
  );
}

/** 清空 —— 列表是会话内的东西，登出即作废。 */
export function clearConversationListCache(): void {
  const dirty = grouped !== null || archived !== null;
  grouped = null;
  archived = null;
  if (dirty) emit();
}

export function __resetConversationListCacheForTests(): void {
  clearConversationListCache();
}
