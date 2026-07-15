import {
  useConversations,
  useGroupedConversations,
} from "@/hooks/useConversations";
import { useLlmKey } from "@/hooks/useLlmKey";
import {
  hasModelAccess,
  isOnboardingSkipped,
  shouldShowOnboarding,
} from "@/lib/onboarding";
import { useOnboardingUiStore } from "@/stores/onboardingUi";
import { useSyncExternalStore } from "react";

/** Subscribe to skip flag changes within the same session via a tiny bump. */
let skipEpoch = 0;
const skipListeners = new Set<() => void>();

function subscribeSkip(cb: () => void): () => void {
  skipListeners.add(cb);
  return () => {
    skipListeners.delete(cb);
  };
}

function getSkipEpoch(): number {
  return skipEpoch;
}

/** Call after writing the skip flag so gates re-evaluate. */
export function notifyOnboardingSkipChanged(): void {
  skipEpoch += 1;
  for (const cb of skipListeners) cb();
}

/**
 * Whether the full-page onboarding flow should cover the app right now.
 * Waits for llm-key + conversations queries so we don't flash the wizard for
 * returning users.
 */
export function useShouldShowOnboardingFlow(): {
  ready: boolean;
  show: boolean;
} {
  const forceOpen = useOnboardingUiStore((s) => s.forceOpen);
  const skipTick = useSyncExternalStore(subscribeSkip, getSkipEpoch, () => 0);
  const llm = useLlmKey();
  const grouped = useGroupedConversations();
  const conversations = useConversations();

  const ready = !llm.isLoading && !grouped.isLoading && llm.isFetched;
  // Touch skipTick so React re-renders after markOnboardingSkipped.
  void skipTick;

  if (forceOpen) return { ready: true, show: true };
  if (!ready) return { ready: false, show: false };

  const show = shouldShowOnboarding({
    hasModelAccess: hasModelAccess(llm.data),
    freeTierActive: llm.data?.free_tier_active === true,
    conversationCount: conversations.length,
    skipped: isOnboardingSkipped(),
  });
  return { ready: true, show };
}
