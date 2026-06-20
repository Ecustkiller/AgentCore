import { useConversations } from "@/hooks/useConversations";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import type { FolderMeta } from "@/services/folders";
import { type WorkspaceInfo, listWorkspaces } from "@/services/workspaces";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * The user's workspaces (= folders, cloud + local) as React Query data — the
 * cross-workspace 文件 hub's rail source, backed by `GET /v1/workspaces`. The
 * endpoint enumerates folders only (裸聊 has no workspace, so it never appears).
 *
 * Unlike the conversation list (loaded once, then driven optimistically), the
 * workspace list has no client-side mutation path of its own: it changes when a
 * folder is created / bound / deleted elsewhere, and the hub is opened on demand.
 * A short stale window keeps it fresh on revisit without the never-refetch
 * contract; the returned query object lets the page tell loading from empty.
 *
 * Folder lifecycle now lives *on* this hub (文件夹即工作区), so folder CRUD reflects
 * into this same cache via the projection helpers below — keeping the rail and the
 * `/conversations` folder filter (grouped cache) in step without a refetch.
 */
export function useWorkspaces() {
  return useQuery({
    queryKey: workspaceKeys.list,
    queryFn: listWorkspaces,
    staleTime: 30_000,
  });
}

/**
 * The {@link WorkspaceInfo} backing a single conversation's side panel — the chat
 * panel's counterpart to the hub's full rail. 文件夹即工作区: a conversation's
 * workspace is its folder's, so we map conversationId → folderId → `folder:<id>` in
 * the **same** `useWorkspaces` cache the hub reads. That makes cloud/local + subpath
 * resolve identically in both surfaces, and both stay live through the one
 * `workspace_promoted` SSE patch (it patches the conversation's folderId *and* adds
 * the workspace) — so a 裸聊's first file write reactively surfaces its new workspace
 * here with no manual refresh.
 *
 * Returns null for a 裸聊 with no folder yet (nothing written), or while the
 * workspace list is still loading: the panel falls back to its conversation-keyed
 * cloud source, which lists cloud files and shows an empty hint pre-promotion.
 */
export function useConversationWorkspace(
  conversationId: string | null,
): WorkspaceInfo | null {
  const conversations = useConversations();
  const { data: workspaces } = useWorkspaces();
  return useMemo(() => {
    if (!conversationId) return null;
    const folderId = conversations.find(
      (c) => c.id === conversationId,
    )?.folderId;
    if (!folderId) return null;
    const wsId = `folder:${folderId}`;
    return workspaces?.find((w) => w.wsId === wsId) ?? null;
  }, [conversationId, conversations, workspaces]);
}

/** Project a folder onto its rail shape (`ws_id = folder:<id>`). A bound local
 * root makes it a local workspace; otherwise it's cloud. `hasFiles` only gates
 * copy elsewhere (not the rail), so a fresh cloud folder is `false` and a local
 * one `true` (the server can't see a local folder's files). */
function folderToWorkspace(f: FolderMeta): WorkspaceInfo {
  const isLocal = !!f.localRootId;
  return {
    wsId: `folder:${f.id}`,
    name: f.name,
    location: isLocal ? "local" : "cloud",
    rootId: f.localRootId,
    // 工作区对称化 D1a：透传文件夹的子路径。UI 新建 / 添加本地文件夹恒为根级（""）；懒建的
    // per 对话工作区由服务端建、经 listWorkspaces 刷新带回真实子路径——此乐观投影一般只碰前者。
    subpath: f.localSubpath,
    hasFiles: isLocal,
  };
}

/** Rewrite the cached workspace list *iff* it's already loaded. Folder CRUD on any
 * surface reflects here so the 文件 rail stays in sync; if the hub was never opened
 * the cache is absent and we skip — it fetches fresh on first open. */
function writeWorkspaces(
  updater: (list: WorkspaceInfo[]) => WorkspaceInfo[],
): void {
  const cur = queryClient.getQueryData<WorkspaceInfo[]>(workspaceKeys.list);
  if (!cur) return;
  queryClient.setQueryData<WorkspaceInfo[]>(workspaceKeys.list, updater(cur));
}

/** Reflect a newly created folder into the rail (newest first). */
export function addWorkspaceFromFolder(folder: FolderMeta): void {
  const ws = folderToWorkspace(folder);
  writeWorkspaces((list) => [ws, ...list.filter((w) => w.wsId !== ws.wsId)]);
}

/** Reflect a folder rename onto its rail item (no-op if the rail isn't loaded). */
export function patchWorkspaceFromFolder(
  id: string,
  patch: { name?: string },
): void {
  const wsId = `folder:${id}`;
  writeWorkspaces((list) =>
    list.map((w) => (w.wsId === wsId ? { ...w, ...patch } : w)),
  );
}

/** Drop a deleted folder from the rail. */
export function removeWorkspaceForFolder(id: string): void {
  const wsId = `folder:${id}`;
  writeWorkspaces((list) => list.filter((w) => w.wsId !== wsId));
}
