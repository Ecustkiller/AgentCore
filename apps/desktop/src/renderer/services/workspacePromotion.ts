import { patchConversationCache } from "@/hooks/useConversations";
import { addFolderCache } from "@/hooks/useFolders";
import { addWorkspaceFromFolder } from "@/hooks/useWorkspaces";
import type { FolderMeta } from "@/services/folders";

/**
 * Reflect a 裸聊's lazy promotion into the three client caches a new folder touches,
 * so the chat re-groups and its workspace card surfaces **now** — without a refetch
 * (文件夹即工作区 §懒建 / 工作区对称化 D1a).
 *
 * The single client-side promotion sink, shared by BOTH paths so they can't drift:
 *  - the team's first write → the ``workspace_promoted`` SSE event (mid-turn, live);
 *  - the panel's first write → the promote endpoint (REST, no live stream), used by
 *    the desktop 裸聊's deferred-local source.
 *
 * ① folder list (sidebar gains its folder-filter row), ② the conversation's folderId
 * (it leaves 未分组 and re-groups under the folder — and the panel re-resolves its
 * source from this), ③ the 文件 hub workspace rail (the new card; local promotions
 * carry their subpath so the just-written file is reachable). Each patch is a no-op if
 * its cache was never populated (it fetches fresh on first open).
 */
export function applyConversationPromotion(
  conversationId: string,
  folder: FolderMeta,
): void {
  addFolderCache(folder);
  patchConversationCache(conversationId, { folderId: folder.id });
  addWorkspaceFromFolder(folder);
}
