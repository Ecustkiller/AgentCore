import { create } from "zustand";

/**
 * Ephemeral onboarding UI state (not persisted).
 * `forceOpen` lets empty-state CTA reopen the wizard after skip.
 */
type OnboardingUiState = {
  forceOpen: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
};

export const useOnboardingUiStore = create<OnboardingUiState>((set) => ({
  forceOpen: false,
  openOnboarding: () => set({ forceOpen: true }),
  closeOnboarding: () => set({ forceOpen: false }),
}));
