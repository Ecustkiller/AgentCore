import { queryClient } from "@/lib/queryClient";
import { conversationKeys } from "@/lib/queryKeys";
import {
  deleteConversation as apiDeleteConversation,
  moveConversation as apiMoveConversation,
  renameConversation as apiRenameConversation,
  listGrouped,
} from "@/services/conversations";
import type { FolderMeta } from "@/services/folders";
import type { Conversation } from "@/stores/conversation";
import { useMutation, useQuery } from "@tanstack/react-query";

/**
 * The conversation list as React Query data (REST 数据层 — the reference slice).
 *
 * `/v1/conversations/grouped` returns folders + conversations in one trip, so the
 * cached value keeps both halves; conversation consumers read the `conversations`
 * half via {@link useConversations}, and the shell seeds the folders store from
 * the `folders` half (folder CRUD still lives in its own store for now).
 *
 * The list is loaded once and then driven optimistically (mirroring the prior
 * hydrate-once + optimistic-mutation model), so it never refetches under the
 * user. The imperative cache helpers below let non-React callers (the SSE turn
 * pipeline, the composer) mutate that same cache.
 */
export interface GroupedConversations {
  folders: FolderMeta[];
  conversations: Conversation[];
}

/** Stable empty list so a component without data keeps a constant reference. */
const EMPTY_CONVERSATIONS: Conversation[] = [];

function readGrouped(): GroupedConversations {
  return (
    queryClient.getQueryData<GroupedConversations>(
      conversationKeys.grouped,
    ) ?? {
      folders: [],
      conversations: [],
    }
  );
}

/** Imperative read of the cached conversation list (for non-React callers). */
export function getConversations(): Conversation[] {
  return readGrouped().conversations;
}

/** Rewrite the cached conversation list, leaving the folders half untouched. */
function writeConversations(
  updater: (list: Conversation[]) => Conversation[],
): void {
  queryClient.setQueryData<GroupedConversations>(
    conversationKeys.grouped,
    (old) => {
      const base = old ?? { folders: [], conversations: [] };
      return { ...base, conversations: updater(base.conversations) };
    },
  );
}

/** Prepend a conversation (or move an existing one to the front, deduped). */
export function upsertConversationFront(conv: Conversation): void {
  writeConversations((list) => [conv, ...list.filter((c) => c.id !== conv.id)]);
}

/** Drop a conversation from the cached list. */
export function removeConversationFromCache(id: string): void {
  writeConversations((list) => list.filter((c) => c.id !== id));
}

/** Shallow-merge a patch onto one cached conversation (no-op if absent). */
export function patchConversationCache(
  id: string,
  patch: Partial<Conversation>,
): void {
  writeConversations((list) =>
    list.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  );
}

/** Move a conversation to the top and stamp `updatedAt = now` (a turn bumps it
 * into the「今天」group like the backend ordering will on the next reload). */
export function bumpConversationCache(id: string): void {
  writeConversations((list) => {
    const target = list.find((c) => c.id === id);
    if (!target) return list;
    return [
      { ...target, updatedAt: new Date().toISOString() },
      ...list.filter((c) => c.id !== id),
    ];
  });
}

/** Undo an optimistic {@link bumpConversationCache}: put the conversation back
 * at `index` and restore its `updatedAt`. */
export function restoreConversationCache(
  id: string,
  index: number,
  updatedAt: string,
): void {
  writeConversations((list) => {
    const target = list.find((c) => c.id === id);
    if (!target) return list;
    const without = list.filter((c) => c.id !== id);
    const at = Math.max(0, Math.min(index, without.length));
    return [
      ...without.slice(0, at),
      { ...target, updatedAt },
      ...without.slice(at),
    ];
  });
}

/** The grouped folders+conversations query — the single network source for the
 * sidebar / conversations list. Loaded once, then optimistic. */
export function useGroupedConversations() {
  return useQuery({
    queryKey: conversationKeys.grouped,
    queryFn: listGrouped,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** Reactive conversation list (server-ordered; consumers re-sort by recency). */
export function useConversations(): Conversation[] {
  return useGroupedConversations().data?.conversations ?? EMPTY_CONVERSATIONS;
}

/** Persist a title rename, optimistic with rollback on failure. */
export function useRenameConversation() {
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiRenameConversation(id, title),
    onMutate: ({ id, title }) => {
      const prev = getConversations().find((c) => c.id === id)?.title ?? null;
      patchConversationCache(id, { title });
      return { id, prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev != null)
        patchConversationCache(ctx.id, { title: ctx.prev });
    },
  });
}

/** Move a conversation into a folder (`null` = ungrouped), optimistic with
 * rollback to the previous folder if the server rejects the move. */
export function useMoveConversation() {
  return useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      apiMoveConversation(id, folderId),
    onMutate: ({ id, folderId }) => {
      const prev =
        getConversations().find((c) => c.id === id)?.folderId ?? null;
      patchConversationCache(id, { folderId });
      return { id, prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) patchConversationCache(ctx.id, { folderId: ctx.prev });
    },
  });
}

/** Soft-delete a conversation server-side, then drop it from the cache (delete
 * first so a failed delete leaves the row in place). */
export function useDeleteConversation() {
  return useMutation({
    mutationFn: (id: string) => apiDeleteConversation(id),
    onSuccess: (_data, id) => removeConversationFromCache(id),
  });
}
