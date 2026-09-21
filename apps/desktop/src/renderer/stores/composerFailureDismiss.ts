import { create } from "zustand";

/**
 * View-only dismiss for the composer failure banner.
 * Keyed by the last turn. Not persisted: leaving the conversation clears it,
 * so coming back shows the sentence again while that turn is still last.
 */
type ComposerFailureDismissState = {
  key: string | null;
  dismiss: (key: string) => void;
  clear: () => void;
};

export const useComposerFailureDismissStore =
  create<ComposerFailureDismissState>((set) => ({
    key: null,
    dismiss: (key) => set({ key }),
    clear: () => set({ key: null }),
  }));

export function failureBannerKey(
  conversationId: string | null,
  messageId: string,
): string {
  return `${conversationId ?? ""}:${messageId}`;
}

export function useFailureBannerDismissed(
  conversationId: string | null,
  messageId: string | null,
): boolean {
  const key = messageId ? failureBannerKey(conversationId, messageId) : null;
  return useComposerFailureDismissStore((s) => key != null && s.key === key);
}

export function dismissFailureBanner(
  conversationId: string | null,
  messageId: string,
): void {
  useComposerFailureDismissStore
    .getState()
    .dismiss(failureBannerKey(conversationId, messageId));
}

export function clearFailureBannerDismiss(): void {
  useComposerFailureDismissStore.getState().clear();
}
