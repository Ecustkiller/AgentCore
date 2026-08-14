import type { ErrorAction } from "@/lib/errors";
import { create } from "zustand";

/**
 * Ephemeral send-refusal copy on the composer card (not the textarea, not
 * persisted). Survives first-send teardown back to ``__draft__`` after the
 * conversation slice is gone. Conversation-scoped ``setError`` still feeds
 * canvas {@link import("@/components/chat/RetryBanner").RetryBanner}.
 */
export type ComposerSendError = {
  message: string;
  action: ErrorAction | null;
};

type ComposerSendErrorState = {
  byKey: Record<string, ComposerSendError>;
  setError: (key: string, error: ComposerSendError) => void;
  clearError: (key: string) => void;
};

export const useComposerSendErrorStore = create<ComposerSendErrorState>(
  (set) => ({
    byKey: {},
    setError: (key, error) =>
      set((s) => ({ byKey: { ...s.byKey, [key]: error } })),
    clearError: (key) =>
      set((s) => {
        if (!(key in s.byKey)) return s;
        const { [key]: _dropped, ...rest } = s.byKey;
        return { byKey: rest };
      }),
  }),
);

export function setComposerSendError(
  key: string,
  error: ComposerSendError,
): void {
  useComposerSendErrorStore.getState().setError(key, error);
}

export function clearComposerSendError(key: string): void {
  useComposerSendErrorStore.getState().clearError(key);
}

export function useComposerSendError(key: string): ComposerSendError | null {
  return useComposerSendErrorStore((s) => s.byKey[key] ?? null);
}
