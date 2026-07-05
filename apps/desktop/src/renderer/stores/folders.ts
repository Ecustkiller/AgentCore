import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Filter key for the synthetic "ungrouped" section (not a real folder). */
export const UNGROUPED_KEY = "__ungrouped__";

/**
 * Pure-UI folder state. The folder *list* is server data owned by React Query
 * (see `hooks/useFolders`); only these ephemeral, view-only flags — which a
 * cache doesn't model — live here, coordinating one-shot UI handoffs between the
 * folder-CRUD action and the component that should react to it.
 */
interface FoldersUiState {
  /** A just-created folder whose header should open in inline-rename mode. */
  pendingRenameId: string | null;
  /** Folder a freshly-started draft conversation should be filed into on its
   * first send ("新建对话" from a folder header). Cleared once consumed. */
  pendingNewChatFolderId: string | null;
  /** 「云端临时对话」逃生口标记（决策 #11）：true ⇒ 这条草稿首发显式走纯云、绕开桌面
   * 默认本地工作区。与 `pendingNewChatFolderId == null` 的「未指定（桌面默认本地）」区分——
   * 否则首发处无法分辨「没选文件夹」和「明确要云」。消费后复位 false。 */
  pendingNewChatCloud: boolean;
  /** User-pinned folders shown at the top of workspace pickers. */
  pinnedFolderIds: string[];

  setPendingRename: (id: string | null) => void;
  setPendingNewChatFolder: (id: string | null) => void;
  setPendingNewChatCloud: (cloud: boolean) => void;
  togglePinFolder: (id: string) => void;
}

export const useFoldersStore = create<FoldersUiState>()(
  persist(
    (set) => ({
      pendingRenameId: null,
      pendingNewChatFolderId: null,
      pendingNewChatCloud: false,
      pinnedFolderIds: [],
      setPendingRename: (id) => set({ pendingRenameId: id }),
      setPendingNewChatFolder: (id) => set({ pendingNewChatFolderId: id }),
      setPendingNewChatCloud: (cloud) => set({ pendingNewChatCloud: cloud }),
      togglePinFolder: (id) =>
        set((s) => ({
          pinnedFolderIds: s.pinnedFolderIds.includes(id)
            ? s.pinnedFolderIds.filter((x) => x !== id)
            : [...s.pinnedFolderIds, id],
        })),
    }),
    {
      name: "folders-ui",
      partialize: (s) => ({ pinnedFolderIds: s.pinnedFolderIds }),
    },
  ),
);
