import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { useShouldShowOnboardingFlow } from "@/hooks/useOnboarding";
import { isWebPreview } from "@/lib/preview";

/**
 * Mounts the full-page first-run flow above the authenticated shell when
 * eligibility holds (or when empty-state CTA forces it open).
 * Offline `#/preview` skips auto-show so conformance shoots stay clean.
 */
export function OnboardingGate() {
  const { ready, show } = useShouldShowOnboardingFlow();
  if (isWebPreview()) return null;
  if (!ready || !show) return null;
  return <OnboardingFlow />;
}
