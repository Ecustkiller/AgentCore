import type { FolderMeta } from "@/services/folders";
import { create } from "zustand";

/** Collapse-state key for the synthetic "ungrouped" section (not a real folder). */
export const UNGROUPED_KEY = "__ungrouped__";

const COLLAPSED_KEY = "agentcore:folder-collapsed";

// localStorage is wrapped: it throws in private-mode / non-DOM (test) contexts.
// A failed read falls back to "all expanded"; a failed write keeps state in
// memory for the session.
function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistCollapsed(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(map));
  } catch {
    /* unavailable — session-only */
  }
}

interface FoldersState {
  folders: FolderMeta[];
  /** key → collapsed?; a missing key means expanded (default open, §七). */
  collapsed: Record<string, boolean>;
  /** A just-created folder whose header should open in inline-rename mode. */
  pendingRenameId: string | null;
  /** Folder a freshly-started draft conversation should be filed into on its
   * first send ("新建对话" from a folder header). Cleared once consumed. */
  pendingNewChatFolderId: string | null;

  setFolders: (folders: FolderMeta[]) => void;
  /** Prepend a new folder (newest first, before server reorders on reload). */
  addFolder: (folder: FolderMeta) => void;
  updateFolderMeta: (
    id: string,
    patch: Partial<Omit<FolderMeta, "id">>,
  ) => void;
  removeFolder: (id: string) => void;
  toggleCollapsed: (key: string) => void;
  setPendingRename: (id: string | null) => void;
  setPendingNewChatFolder: (id: string | null) => void;
}

export const useFoldersStore = create<FoldersState>((set) => ({
  folders: [],
  collapsed: loadCollapsed(),
  pendingRenameId: null,
  pendingNewChatFolderId: null,

  setFolders: (folders) => set({ folders }),

  addFolder: (folder) =>
    set((state) => ({ folders: [folder, ...state.folders] })),

  updateFolderMeta: (id, patch) =>
    set((state) => ({
      folders: state.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    })),

  removeFolder: (id) =>
    set((state) => {
      const { [id]: _dropped, ...collapsed } = state.collapsed;
      return { folders: state.folders.filter((f) => f.id !== id), collapsed };
    }),

  toggleCollapsed: (key) =>
    set((state) => {
      const collapsed = { ...state.collapsed, [key]: !state.collapsed[key] };
      persistCollapsed(collapsed);
      return { collapsed };
    }),

  setPendingRename: (id) => set({ pendingRenameId: id }),

  setPendingNewChatFolder: (id) => set({ pendingNewChatFolderId: id }),
}));
