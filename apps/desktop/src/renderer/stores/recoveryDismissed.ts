import { create } from "zustand";

/**
 * Session-only UI latch: boss implicitly ignored the 救火 hint for this
 * assistant projection (new turn started). Does **not** live on Execution —
 * projectExecution / conformance must stay protocol-clean. Not persisted;
 * server audit via acceptRunOutcome is a separate durable trail.
 */
interface RecoveryDismissedState {
  /** Assistant projection ids whose recoverable hint was dismissed. */
  dismissed: ReadonlySet<string>;
  markDismissed: (messageId: string) => void;
  isDismissed: (messageId: string) => boolean;
  reset: () => void;
}

export const useRecoveryDismissedStore = create<RecoveryDismissedState>(
  (set, get) => ({
    dismissed: new Set(),

    markDismissed: (messageId) => {
      if (get().dismissed.has(messageId)) return;
      const next = new Set(get().dismissed);
      next.add(messageId);
      set({ dismissed: next });
    },

    isDismissed: (messageId) => get().dismissed.has(messageId),

    reset: () => set({ dismissed: new Set() }),
  }),
);
