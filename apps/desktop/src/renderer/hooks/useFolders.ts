import type { GroupedConversations } from "@/hooks/useConversations";
import {
  getConversations,
  patchConversationCache,
  useGroupedConversations,
} from "@/hooks/useConversations";
import {
  addWorkspaceFromFolder,
  patchWorkspaceFromFolder,
  removeWorkspaceForFolder,
} from "@/hooks/useWorkspaces";
import { queryClient } from "@/lib/queryClient";
import { conversationKeys } from "@/lib/queryKeys";
import {
  type FolderMeta,
  createFolder,
  deleteFolder,
  updateFolder,
} from "@/services/folders";
import { useMutation } from "@tanstack/react-query";

/**
 * Folders as React Query data — folders share the `/grouped` query (and its
 * cache entry) with conversations, so this reads/writes the `folders` half of
 * that same entry. Pure-UI folder state (pending rename, pending new-chat
 * target) stays in the zustand folders store; only the server-owned list lives
 * here.
 */
const EMPTY_FOLDERS: FolderMeta[] = [];

/** Imperative read of the cached folder list (for non-React callers). */
export function getFolders(): FolderMeta[] {
  return (
    queryClient.getQueryData<GroupedConversations>(conversationKeys.grouped)
      ?.folders ?? []
  );
}

/** Rewrite the cached folder list, leaving the conversations half untouched. */
function writeFolders(updater: (list: FolderMeta[]) => FolderMeta[]): void {
  queryClient.setQueryData<GroupedConversations>(
    conversationKeys.grouped,
    (old) => {
      const base = old ?? { folders: [], conversations: [] };
      return { ...base, folders: updater(base.folders) };
    },
  );
}

/** Prepend a folder (newest first, before the server reorders on reload). */
export function addFolderCache(folder: FolderMeta): void {
  writeFolders((list) => [folder, ...list.filter((f) => f.id !== folder.id)]);
}

/** Shallow-merge a patch onto one cached folder (no-op if absent). Used for the
 * local-only binding reflection (workspace bind/unbind stamps `localRootId`). */
export function patchFolderCache(id: string, patch: Partial<FolderMeta>): void {
  writeFolders((list) =>
    list.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  );
}

/** Drop a folder from the cached list. */
export function removeFolderFromCache(id: string): void {
  writeFolders((list) => list.filter((f) => f.id !== id));
}

/** Reactive folder list (server-ordered). */
export function useFolders(): FolderMeta[] {
  return useGroupedConversations().data?.folders ?? EMPTY_FOLDERS;
}

/** Create a folder, then add it to the cache. `mutateAsync` returns the new
 * folder so the caller can name / select / file into it. */
export function useCreateFolder() {
  return useMutation({
    mutationFn: ({
      name,
      localDir,
      localRootId,
    }: {
      name: string;
      localDir?: string | null;
      // Bind to a desktop FS root at creation (文件中枢统一 F2: 加文件夹 = 建本地项目).
      localRootId?: string | null;
    }) => createFolder(name, localDir, localRootId),
    onSuccess: (folder) => {
      addFolderCache(folder);
      // 文件夹即工作区：新建文件夹随即作为一个工作区出现在 文件 hub 的 rail。
      addWorkspaceFromFolder(folder);
    },
  });
}

/** Rename / re-bind a folder, optimistic with rollback on failure. */
export function useUpdateFolder() {
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string; localDir?: string | null };
    }) => updateFolder(id, patch),
    onMutate: ({ id, patch }) => {
      const prev = getFolders().find((f) => f.id === id) ?? null;
      const cachePatch: Partial<FolderMeta> = {};
      if (patch.name !== undefined) cachePatch.name = patch.name;
      if (patch.localDir !== undefined) cachePatch.localDir = patch.localDir;
      patchFolderCache(id, cachePatch);
      // Mirror the rename onto the 文件 hub rail (name is the only rail-visible field).
      if (patch.name !== undefined)
        patchWorkspaceFromFolder(id, { name: patch.name });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        patchFolderCache(ctx.prev.id, {
          name: ctx.prev.name,
          localDir: ctx.prev.localDir,
        });
        patchWorkspaceFromFolder(ctx.prev.id, { name: ctx.prev.name });
      }
    },
  });
}

/** Delete a folder server-side, then drop it from the cache and unbind its
 * conversations into 未分组 (the server does the unbind; we mirror it). Bundling
 * the unbind here keeps the two delete sites (sidebar + page) from duplicating
 * it. */
export function useDeleteFolder() {
  return useMutation({
    mutationFn: (id: string) => deleteFolder(id),
    onSuccess: (_data, id) => {
      for (const c of getConversations()) {
        if (c.folderId === id) patchConversationCache(c.id, { folderId: null });
      }
      removeFolderFromCache(id);
      removeWorkspaceForFolder(id);
    },
  });
}
