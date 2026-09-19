import { ChatView } from "@/components/chat/ChatView";
import { ScenarioList } from "@/components/preview/ScenarioList";
import { Button } from "@/components/ui";
import { PREVIEW_FIXTURES } from "@/preview/fixtures";
import {
  replayFixtureNow,
  replayFixturePrefix,
  replayFixtureStreamed,
} from "@/preview/replay";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { type TurnDetailView, turnDetailPath } from "@/stores/ui";
import { Play, Radio } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

const convIdFor = (name: string) => `preview-${name}`;

/**
 * Hidden dev route (`#/preview`) for eyeballing every AI state offline. Each entry
 * is a committed conformance vector replayed through the real SSE dispatch into the
 * real ChatView — no backend, no LLM, no tokens. Reachable by typing the URL; not
 * in the nav. Appearance follows the app theme (`useApplyTheme` on the shell).
 */
export function PreviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const cancelRef = useRef<(() => void) | null>(null);

  // Scenario selection is URL-driven (`#/preview?s=<name>`) so the screenshot
  // harness (scripts/shoot.mjs) can deep-link each scenario deterministically and
  // humans can bookmark one. Fall back to the first fixture so the pane is never
  // empty.
  const scenarios = PREVIEW_FIXTURES;

  const requested = searchParams.get("s");
  const current =
    scenarios.find((s) => s.name === requested) ?? scenarios[0] ?? null;
  const selected = current?.name ?? null;

  // Mid-stream frame index (`#/preview?s=…&k=<n>`): replay only the first n events
  // instead of the terminal state. Drives the harness's streaming frame scrubber;
  // null = full/terminal. Invalid / ≤0 → treated as full.
  const frameRaw = searchParams.get("k");
  const parsedFrame =
    frameRaw === null ? Number.NaN : Number.parseInt(frameRaw, 10);
  const frame =
    Number.isFinite(parsedFrame) && parsedFrame > 0 ? parsedFrame : null;

  // Total replayable events in the current scenario → the scrubber's right end
  // (terminal state). The slider spans 1…total; landing on total drops `k` so the
  // URL collapses back to the canonical terminal form the harness screenshots.
  const total = current?.events.length ?? 0;

  // Deep-link into a full-screen turn-detail view (`#/preview?s=…&zoom=<view>`):
  // after the fixture replays, navigate to `turnDetailPath` so a zoomed view that is
  // otherwise only reachable by clicking is deep-linkable + shoot-gatable.
  // `zoom=debate` / `zoom=graph` → that tab; any other truthy value → the turn's default.
  const zoom = searchParams.get("zoom");

  const stopStreamed = () => {
    cancelRef.current?.();
    cancelRef.current = null;
  };

  const select = (name: string) => {
    setSearchParams({ s: name }, { replace: true });
  };

  // Drag the scrubber → rewrite `?k=`. At/over the right end we drop `k` entirely
  // (terminal). The URL stays the single source of truth: the effect below re-replays
  // the prefix and data-preview-frame updates, so the screenshot harness and a human
  // scrubbing land on the exact same frame.
  const setFrame = (value: number) => {
    if (!selected) return;
    if (value >= total) {
      setSearchParams({ s: selected }, { replace: true });
    } else {
      setSearchParams(
        { s: selected, k: String(Math.max(1, value)) },
        { replace: true },
      );
    }
  };

  const replayNow = () => {
    if (!current) return;
    stopStreamed();
    replayFixtureNow(
      convIdFor(current.name),
      current.events,
      current.description,
    );
  };

  const playStreamed = () => {
    if (!current) return;
    stopStreamed();
    cancelRef.current = replayFixtureStreamed(
      convIdFor(current.name),
      current.events,
      current.description,
    );
  };

  // Replay on selection / frame change (driven by the URL `?s=` + `?k=` params):
  // a frame index replays only the first k events (mid-stream), otherwise the full
  // terminal state. Kept free of component-scope closures — it talks to the cancel
  // ref directly and re-looks up the fixture — so the dep array is honestly exhaustive.
  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    const sc = scenarios.find((s) => s.name === selected);
    if (sc) {
      const cid = convIdFor(sc.name);
      if (frame !== null) {
        replayFixturePrefix(cid, sc.events, frame, sc.description);
      } else {
        replayFixtureNow(cid, sc.events, sc.description);
      }
    }
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [selected, frame, scenarios]);

  // Drop the synthetic slice when leaving preview — but keep it when `?zoom=`
  // navigates into that preview conversation's turn-detail route (seed must survive).
  useEffect(() => {
    return () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (hash.startsWith("/conversations/preview-")) return;
      useConversationStore.getState().switchConversation(null);
    };
  }, []);

  // After replay lands, honor `?zoom=` by navigating to the real turn-detail route
  // (`turnDetailPath`) — same as production 放大态, so SHOOT_ZOOM is no longer a no-op.
  // biome-ignore lint/correctness/useExhaustiveDependencies: frame is an intentional re-run key — re-focus after each replay frame lands.
  useEffect(() => {
    if (!zoom || !selected) return;
    const focusView: TurnDetailView | undefined =
      zoom === "debate" ? "debate" : zoom === "graph" ? "graph" : undefined;
    const t = setTimeout(() => {
      const cid = convIdFor(selected);
      const msgs = getRuntime(cid).messages;
      const turn =
        [...msgs].reverse().find((m) => m.executionId != null) ??
        [...msgs].reverse().find((m) => m.role === "assistant");
      if (turn) {
        navigate(turnDetailPath(cid, turn.id, focusView), { replace: true });
      }
    }, 120);
    return () => clearTimeout(t);
  }, [zoom, selected, frame, navigate]);

  return (
    <div
      className="flex h-full min-h-0"
      data-preview-scenario={selected ?? ""}
      data-preview-frame={frame !== null ? String(frame) : "full"}
    >
      <ScenarioList
        fixtures={PREVIEW_FIXTURES}
        selected={selected}
        onSelect={select}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2">
          <div className="min-w-0 shrink">
            <p className="truncate text-sm font-medium text-foreground">
              {current?.name ?? "选择一个场景"}
            </p>
            {current && (
              <p className="truncate text-xs text-muted-foreground">
                {current.description}
              </p>
            )}
          </div>
          {/* Frame scrubber pulled inline so a single control bar carries title +
              scrubbing + actions; falls back to a spacer (keeps the actions
              right-aligned) when the scenario has no mid-stream frames to scrub. */}
          {current && total > 1 ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                帧
              </span>
              <input
                type="range"
                min={1}
                max={total}
                step={1}
                value={frame ?? total}
                onChange={(e) => setFrame(Number(e.target.value))}
                className="h-1 min-w-16 flex-1 cursor-pointer accent-primary"
                aria-label="流式中间帧 scrubber"
              />
              <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {frame !== null
                  ? `第 ${frame} / ${total} 事件`
                  : `终态 · ${total} 事件`}
              </span>
              {frame !== null && (
                <button
                  type="button"
                  onClick={() => setFrame(total)}
                  className="shrink-0 text-xs font-medium text-primary hover:underline"
                >
                  回终态
                </button>
              )}
            </div>
          ) : (
            <div className="flex-1" />
          )}
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
