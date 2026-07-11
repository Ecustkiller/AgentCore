import { hasLocalFiles } from "@/lib/capabilities";
import { createZustandUiStorage } from "@/lib/uiStorage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Filter key for the synthetic "ungrouped" section (not a real folder). */
export const UNGROUPED_KEY = "__ungrouped__";

const uiPersistStorage = createJSONStorage(() => createZustandUiStorage());

/**
 * Draft-time「在哪工作」intent — single discriminant union.
 * Desktop default = quick local scratch; web (no fsApi) = quick cloud.
 */
export type DraftWorkspaceIntent =
  | { kind: "quick_local" }
  | { kind: "quick_cloud" }
  | { kind: "project"; folderId: string };

export function defaultDraftWorkspaceIntent(): DraftWorkspaceIntent {
  return hasLocalFiles()
    ? { kind: "quick_local" }
    : { kind: "quick_cloud" };
}

/**
 * Pure-UI folder state. The folder *list* is server data owned by React Query
 * (see `hooks/useFolders`); only these ephemeral, view-only flags — which a
 * cache doesn't model — live here, coordinating one-shot UI handoffs between the
 * folder-CRUD action and the component that should react to it.
 */
interface FoldersUiState {
  /** A just-created folder whose header should open in inline-rename mode. */
  pendingRenameId: string | null;
  /** Where the current draft will land on first send. */
  draftWorkspaceIntent: DraftWorkspaceIntent;
  /** User-pinned folders shown at the top of workspace pickers. */
  pinnedFolderIds: string[];
  /** Canonical「新建项目」dialog (command palette, etc.). */
  createProjectOpen: boolean;

  setPendingRename: (id: string | null) => void;
  setDraftWorkspaceIntent: (intent: DraftWorkspaceIntent) => void;
  resetDraftWorkspaceIntent: () => void;
  openCreateProject: () => void;
  closeCreateProject: () => void;
  togglePinFolder: (id: string) => void;
}

export const useFoldersStore = create<FoldersUiState>()(
  persist(
    (set) => ({
      pendingRenameId: null,
      draftWorkspaceIntent: defaultDraftWorkspaceIntent(),
      pinnedFolderIds: [],
      createProjectOpen: false,
      setPendingRename: (id) => set({ pendingRenameId: id }),
      setDraftWorkspaceIntent: (intent) =>
        set({ draftWorkspaceIntent: intent }),
      resetDraftWorkspaceIntent: () =>
        set({ draftWorkspaceIntent: defaultDraftWorkspaceIntent() }),
      openCreateProject: () => set({ createProjectOpen: true }),
      closeCreateProject: () => set({ createProjectOpen: false }),
      togglePinFolder: (id) =>
        set((s) => ({
          pinnedFolderIds: s.pinnedFolderIds.includes(id)
            ? s.pinnedFolderIds.filter((x) => x !== id)
            : [...s.pinnedFolderIds, id],
        })),
    }),
    {
      name: "folders-ui",
      storage: uiPersistStorage,
      partialize: (s) => ({ pinnedFolderIds: s.pinnedFolderIds }),
    },
  ),
);
