import { create } from "zustand";

/** Filter key for the synthetic "ungrouped" section (not a real folder). */
export const UNGROUPED_KEY = "__ungrouped__";

/**
 * Pure-UI folder state. The folder *list* is server data owned by React Query
 * (see `hooks/useFolders`); only these two ephemeral, view-only flags — which a
 * cache doesn't model — live here, coordinating one-shot UI handoffs between the
 * folder-CRUD action and the component that should react to it.
 */
interface FoldersUiState {
  /** A just-created folder whose header should open in inline-rename mode. */
  pendingRenameId: string | null;
  /** Folder a freshly-started draft conversation should be filed into on its
   * first send ("新建对话" from a folder header). Cleared once consumed. */
  pendingNewChatFolderId: string | null;

  setPendingRename: (id: string | null) => void;
  setPendingNewChatFolder: (id: string | null) => void;
}

export const useFoldersStore = create<FoldersUiState>((set) => ({
  pendingRenameId: null,
  pendingNewChatFolderId: null,
  setPendingRename: (id) => set({ pendingRenameId: id }),
  setPendingNewChatFolder: (id) => set({ pendingNewChatFolderId: id }),
}));
