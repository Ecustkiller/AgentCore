import type { FsRoot } from "@shared/ipc-contract";
import { create } from "zustand";

/** 当前选中的文件（用于右侧预览）。 */
export interface SelectedFile {
  rootId: string;
  relPath: string;
  name: string;
}

interface FilesState {
  roots: FsRoot[];
  selected: SelectedFile | null;

  setRoots: (roots: FsRoot[]) => void;
  addRoot: (root: FsRoot) => void;
  removeRoot: (id: string) => void;
  select: (file: SelectedFile | null) => void;
}

/**
 * 轻量文件页 store：仅保存「授权根列表」与「当前选中文件」。
 * 目录树本身不入全局 store —— 各目录节点各自懒读子项并 watch（见 FileTreeNode）。
 */
export const useFilesStore = create<FilesState>((set) => ({
  roots: [],
  selected: null,

  setRoots: (roots) => set({ roots }),

  addRoot: (root) =>
    set((s) =>
      s.roots.some((r) => r.id === root.id) ? s : { roots: [...s.roots, root] },
    ),

  removeRoot: (id) =>
    set((s) => ({
      roots: s.roots.filter((r) => r.id !== id),
      selected: s.selected?.rootId === id ? null : s.selected,
    })),

  select: (selected) => set({ selected }),
}));
