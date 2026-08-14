/**
 * AI 写盘后通知当前对话工作区树静默重拉（根即可）。
 *
 * 不 refetch `workspaceKeys.list`、不换 FileSource——第一笔产物若把列表 invalidate，
 * 侧栏会从 `workspace:<cid>` 落到 `workspace:conv:<cid>`，整树重建转圈。
 * 总线按 sourceId 投递；未挂载的树下次展开本就会拉。
 */

import { notifyFileTreeChanged } from "@/components/files/fileTreeBus";
import { getConversations } from "@/hooks/useConversations";
import { getFolders } from "@/hooks/useFolders";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { bareConversationScratchSubpath } from "@/services/bareScratchPath";
import type { WorkspaceInfo } from "@/services/workspaces";

/** 成功写盘会改树的 builtin（与审批 FILE_OP_TOOLS 对齐，不含 git）。 */
export const TREE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "file_append",
  "str_replace",
  "file_delete",
  "file_move",
  "file_copy",
  "mkdir",
  "file_batch",
]);

/** `makeCloudSource`：`workspace:${key}`。 */
function cloudSourceId(key: string): string {
  return `workspace:${key}`;
}

/** `createLocalRootSource`：`local:${rootId}` / `local:${rootId}:${subpath}`。 */
function localSourceId(rootId: string, subpath: string): string {
  const base = subpath.replace(/^\/+|\/+$/g, "");
  return base ? `local:${rootId}:${base}` : `local:${rootId}`;
}

/**
 * 本对话可能已挂载的工作区 FileSource.id。
 * 侧栏在列表尚未有 `conv:` 行时用 `workspace:<cid>`；中枢合成轨用 `workspace:conv:<cid>`。
 */
export function conversationWorkspaceSourceIds(
  conversationId: string,
): string[] {
  const ids = new Set<string>([
    cloudSourceId(conversationId),
    cloudSourceId(`conv:${conversationId}`),
  ]);

  const conv = getConversations().find((c) => c.id === conversationId) ?? null;
  const workspaces =
    queryClient.getQueryData<WorkspaceInfo[]>(workspaceKeys.list) ?? [];

  if (conv?.folderId) {
    const wsId = `folder:${conv.folderId}`;
    ids.add(cloudSourceId(wsId));
    const listed = workspaces.find((w) => w.wsId === wsId);
    if (listed?.location === "local" && listed.rootId) {
      ids.add(localSourceId(listed.rootId, listed.subpath ?? ""));
    } else {
      const folder = getFolders().find((f) => f.id === conv.folderId);
      if (folder?.mode === "local" && folder.localRootId) {
        ids.add(localSourceId(folder.localRootId, folder.localSubpath ?? ""));
      }
    }
  }

  const listedScratch = workspaces.find(
    (w) => w.wsId === `conv:${conversationId}`,
  );
  if (listedScratch?.location === "local" && listedScratch.rootId) {
    let sub = (listedScratch.subpath ?? "").replace(/^\/+|\/+$/g, "");
    if (
      !sub &&
      conv?.localContainerRootId &&
      listedScratch.rootId === conv.localContainerRootId
    ) {
      sub = bareConversationScratchSubpath(conversationId);
    }
    ids.add(localSourceId(listedScratch.rootId, sub));
  } else if (conv?.localContainerRootId) {
    ids.add(
      localSourceId(
        conv.localContainerRootId,
        bareConversationScratchSubpath(conversationId),
      ),
    );
  }

  // 绑定卡乐观根：还没有 folderId / conv: 行时，FileWorkbench 挂 `local:{localRootId}`。
  if (conv?.localRootId && conv.localRootId !== conv.localContainerRootId) {
    ids.add(localSourceId(conv.localRootId, ""));
  }

  return [...ids];
}

/** 对当前对话工作区 source 广播根变更。空 id 为 no-op。 */
export function notifyConversationWorkspaceTree(conversationId: string): void {
  const cid = conversationId.trim();
  if (!cid) return;
  for (const sourceId of conversationWorkspaceSourceIds(cid)) {
    notifyFileTreeChanged({ sourceId, dir: "" });
  }
}
