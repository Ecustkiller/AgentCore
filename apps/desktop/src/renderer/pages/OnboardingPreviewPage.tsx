import { DraftEmptyState } from "@/components/onboarding/DraftEmptyState";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { ONBOARDING_PREVIEW_SCENES } from "@/preview/onboardingScenes";
import { FlaskConical } from "lucide-react";
import { useSearchParams } from "react-router-dom";

/**
 * Hidden preview (`#/preview/onboarding`) for first-run wizard + draft empty states.
 * Deep-link: `#/preview/onboarding?s=onboarding-value` 等。
 */
export function OnboardingPreviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const scenes = ONBOARDING_PREVIEW_SCENES;
  const requested = searchParams.get("s");
  const current = scenes.find((s) => s.id === requested) ?? scenes[0] ?? null;
  const selected = current?.id ?? null;

  const select = (id: string) => setSearchParams({ s: id }, { replace: true });

  return (
    <div
      className="flex h-full min-h-0 w-full"
      data-preview-onboarding={selected ?? ""}
    >
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FlaskConical size={18} className="shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-foreground">
              首启体验 · 预览
            </h1>
            <p className="text-xs text-muted-foreground">
              {scenes.length} 个场景 · 离线自检
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <ul className="space-y-0.5">
            {scenes.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => select(s.id)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left ${
                    selected === s.id
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <span className="block truncate text-sm font-medium">
                    {s.title}
                  </span>
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                    {s.id}
                  </span>
                  <span className="mt-1 block text-xs leading-snug text-muted-foreground">
                    {s.intent}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {current?.kind === "onboarding-value" && (
          <OnboardingFlow
            embedded
            previewStep="value"
            onDismiss={() => undefined}
          />
        )}
        {current?.kind === "onboarding-connect" && (
          <OnboardingFlow
            embedded
            previewStep="connect"
            onDismiss={() => undefined}
          />
        )}
        {current?.kind === "onboarding-probing" && (
          <OnboardingFlow
            embedded
            previewStep="probing"
            onDismiss={() => undefined}
          />
        )}
        {current?.kind?.startsWith("empty-") && (
          <div className="flex h-full items-center justify-center py-10">
            <DraftEmptyState
              previewKind={
                current.kind === "empty-needs-key"
                  ? "needs_key"
                  : current.kind === "empty-starter-chips"
                    ? "starter_chips"
                    : "returning"
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
