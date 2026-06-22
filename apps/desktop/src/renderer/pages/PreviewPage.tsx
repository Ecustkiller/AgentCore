import { ChatView } from "@/components/chat/ChatView";
import { Button } from "@/components/ui";
import { PREVIEW_FIXTURES, type PreviewFixture } from "@/preview/fixtures";
import { replayFixtureNow, replayFixtureStreamed } from "@/preview/replay";
import { useConversationStore } from "@/stores/conversation";
import { FlaskConical, Play, Radio } from "lucide-react";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

const convIdFor = (fx: PreviewFixture) => `preview-${fx.name}`;

/**
 * Hidden dev route (`#/preview`) for eyeballing every AI state offline. Each entry
 * is a committed conformance vector replayed through the real SSE dispatch into the
 * real ChatView — no backend, no LLM, no tokens. Reachable by typing the URL; not
 * in the nav.
 */
export function PreviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const cancelRef = useRef<(() => void) | null>(null);

  // Scenario selection is URL-driven (`#/preview?s=<name>`) so the screenshot
  // harness (scripts/shoot.mjs) can deep-link each scenario deterministically and
  // humans can bookmark one. Fall back to the first fixture so the pane is never
  // empty.
  const requested = searchParams.get("s");
  const current =
    PREVIEW_FIXTURES.find((f) => f.name === requested) ??
    PREVIEW_FIXTURES[0] ??
    null;
  const selected = current?.name ?? null;

  const stopStreamed = () => {
    cancelRef.current?.();
    cancelRef.current = null;
  };

  const select = (name: string) => {
    setSearchParams({ s: name }, { replace: true });
  };

  const replayNow = () => {
    if (!current) return;
    stopStreamed();
    replayFixtureNow(convIdFor(current), current.events, current.description);
  };

  const playStreamed = () => {
    if (!current) return;
    stopStreamed();
    cancelRef.current = replayFixtureStreamed(
      convIdFor(current),
      current.events,
      current.description,
    );
  };

  // Replay the selected scenario's terminal state whenever the selection changes
  // (driven by the URL `?s=` param). Kept free of component-scope closures — it
  // talks to the cancel ref directly and re-looks up the fixture — so `[selected]`
  // is honestly exhaustive.
  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    const fx = PREVIEW_FIXTURES.find((f) => f.name === selected);
    if (fx) {
      replayFixtureNow(convIdFor(fx), fx.events, fx.description);
    }
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [selected]);

  // Drop the synthetic slice when leaving so it never lingers as the active
  // conversation.
  useEffect(() => {
    return () => {
      useConversationStore.getState().switchConversation(null);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0" data-preview-scenario={selected ?? ""}>
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FlaskConical size={18} className="text-primary" />
          <div>
            <h1 className="text-base font-semibold text-foreground">
              前端预览
            </h1>
            <p className="text-xs text-muted-foreground">
              {PREVIEW_FIXTURES.length} 个 AI 场景 · 离线回放
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {PREVIEW_FIXTURES.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              未找到 fixture。请确认 packages/protocol-conformance/fixtures
              存在。
            </p>
          ) : (
            <ul className="space-y-0.5">
              {PREVIEW_FIXTURES.map((fx) => (
                <li key={fx.name}>
                  <button
                    type="button"
                    onClick={() => select(fx.name)}
                    className={`w-full rounded-lg px-3 py-2 text-left ${
                      selected === fx.name
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <span className="block truncate text-sm font-medium">
                      {fx.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {fx.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {current?.name ?? "选择一个场景"}
            </p>
            {current && (
              <p className="truncate text-xs text-muted-foreground">
                {current.description}
              </p>
            )}
          </div>
          {current && (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="neutral"
                onClick={replayNow}
                icon={<Play size={14} />}
              >
                重放
              </Button>
              <Button
                variant="neutral"
                onClick={playStreamed}
                icon={<Radio size={14} />}
              >
                流式重放
              </Button>
            </div>
          )}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatView />
        </div>
      </div>
    </div>
  );
}
