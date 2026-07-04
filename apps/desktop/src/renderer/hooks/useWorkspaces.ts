import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { type WorkspaceInfo, listWorkspaces } from "@/services/workspaces";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * The user's conversation scratch workspaces as React Query data — the cross-workspace
 * 文件 hub's rail source, backed by `GET /v1/workspaces`. Each entry is a
 * `conv:<conversationId>` scratch space (cloud or local) that has files or a local
 * binding.
 *
 * Unlike the conversation list (loaded once, then driven optimistically), the
 * workspace list has no client-side mutation path of its own: it changes when a
 * conversation gains files / binding elsewhere, and the hub is opened on demand.
 * A short stale window keeps it fresh on revisit without the never-refetch
 * contract; the returned query object lets the page tell loading from empty.
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
 * panel's counterpart to the hub's full rail. Maps `conversationId` → `conv:<id>`
 * in the **same** `useWorkspaces` cache the hub reads so cloud/local + subpath
 * resolve identically in both surfaces.
 *
 * Returns null while the workspace list is still loading or when this conversation
 * has no scratch yet (no files and no local binding): the panel falls back to its
 * conversation-keyed cloud source.
 */
export function useConversationWorkspace(
  conversationId: string | null,
): WorkspaceInfo | null {
  const { data: workspaces } = useWorkspaces();
  return useMemo(() => {
    if (!conversationId) return null;
    const wsId = `conv:${conversationId}`;
    return workspaces?.find((w) => w.wsId === wsId) ?? null;
  }, [conversationId, workspaces]);
}

/** Rewrite the cached workspace list *iff* it's already loaded. If the hub was never
 * opened the cache is absent and we skip — it fetches fresh on first open. */
function writeWorkspaces(
  updater: (list: WorkspaceInfo[]) => WorkspaceInfo[],
): void {
  const cur = queryClient.getQueryData<WorkspaceInfo[]>(workspaceKeys.list);
  if (!cur) return;
  queryClient.setQueryData<WorkspaceInfo[]>(workspaceKeys.list, updater(cur));
}

/** Reflect a newly surfaced conversation scratch into the rail (newest first). */
export function addConversationScratch(ws: WorkspaceInfo): void {
  writeWorkspaces((list) => [ws, ...list.filter((w) => w.wsId !== ws.wsId)]);
}

/** Reflect a conversation rename or binding change onto its rail item. */
export function patchConversationScratch(
  conversationId: string,
  patch: Partial<
    Pick<WorkspaceInfo, "name" | "rootId" | "subpath" | "location" | "hasFiles">
  >,
): void {
  const wsId = `conv:${conversationId}`;
  writeWorkspaces((list) =>
    list.map((w) => (w.wsId === wsId ? { ...w, ...patch } : w)),
  );
}

/** Drop a conversation scratch from the rail (e.g. after unbind with no files). */
export function removeConversationScratch(conversationId: string): void {
  const wsId = `conv:${conversationId}`;
  writeWorkspaces((list) => list.filter((w) => w.wsId !== wsId));
}
