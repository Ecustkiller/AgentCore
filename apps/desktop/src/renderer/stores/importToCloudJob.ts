/**
 * 导入到云后台任务（Dialog 关窗后仍跑）—— 防重入 + AbortController。
 * Toast 进度 / 终态在 {@link startImportToCloudJob}（lib）。
 */
import { create } from "zustand";

type State = {
  running: boolean;
  controller: AbortController | null;
  isRunning: () => boolean;
  /** Soft-cancel in-flight upload loop (keeps cloud folder if already created). */
  cancel: () => void;
  /** Begin a job; returns false if one is already running. */
  begin: (controller: AbortController) => boolean;
  /** Clear running flag when this controller finishes (ignore stale). */
  end: (controller: AbortController) => void;
};

export const useImportToCloudJobStore = create<State>((set, get) => ({
  running: false,
  controller: null,
  isRunning: () => get().running,
  cancel: () => {
    get().controller?.abort();
  },
  begin: (controller) => {
    if (get().running) return false;
    set({ running: true, controller });
    return true;
  },
  end: (controller) => {
    if (get().controller !== controller) return;
    set({ running: false, controller: null });
  },
}));
