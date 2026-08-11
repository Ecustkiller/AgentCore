import { create } from "zustand";

/**
 * Honest mid-flight stop UX: mark that a stop request was sent, without flipping
 * run/execution status to cancelled until SSE says so.
 *
 * Key = `${executionId}:${runId}` for one worker, or `${executionId}:*` for
 * "stop all workers on this execution".
 */
function stopKey(executionId: string, runId: string | null): string {
  return `${executionId}:${runId ?? "*"}`;
}

interface RunStopPendingState {
  /** Keys currently awaiting engine acknowledgement. */
  pending: ReadonlySet<string>;
  markPending: (executionId: string, runId: string | null) => void;
  clearPending: (executionId: string, runId: string | null) => void;
  /** Drop a run-scoped key once that run left pending/running. */
  clearIfSettled: (executionId: string, runId: string, status: string) => void;
  /** Drop the execution-wide key when no workers remain active. */
  clearAllIfIdle: (executionId: string, anyActiveWorker: boolean) => void;
  isPending: (executionId: string, runId: string | null) => boolean;
  /** True if this run is covered by a node stop or an execution-wide stop. */
  isRunCovered: (executionId: string, runId: string) => boolean;
  reset: () => void;
}

export const useRunStopPendingStore = create<RunStopPendingState>(
  (set, get) => ({
    pending: new Set(),

    markPending: (executionId, runId) => {
      const next = new Set(get().pending);
      next.add(stopKey(executionId, runId));
      set({ pending: next });
    },

    clearPending: (executionId, runId) => {
      const key = stopKey(executionId, runId);
      if (!get().pending.has(key)) return;
      const next = new Set(get().pending);
      next.delete(key);
      set({ pending: next });
    },

    clearIfSettled: (executionId, runId, status) => {
      if (status === "pending" || status === "running") return;
      get().clearPending(executionId, runId);
    },

    clearAllIfIdle: (executionId, anyActiveWorker) => {
      if (anyActiveWorker) return;
      get().clearPending(executionId, null);
    },

    isPending: (executionId, runId) =>
      get().pending.has(stopKey(executionId, runId)),

    isRunCovered: (executionId, runId) => {
      const pending = get().pending;
      return (
        pending.has(stopKey(executionId, runId)) ||
        pending.has(stopKey(executionId, null))
      );
    },

    reset: () => set({ pending: new Set() }),
  }),
);
