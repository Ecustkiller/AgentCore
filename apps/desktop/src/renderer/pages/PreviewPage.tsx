import { ChatView } from "@/components/chat/ChatView";
import { ConversationCanvas } from "@/components/graph/ConversationCanvas";
import { SidePanel } from "@/components/layout/SidePanel";
import { Button } from "@/components/ui";
import { PREVIEW_FIXTURES } from "@/preview/fixtures";
import { deleteRecording, useRecordings } from "@/preview/recordings";
import {
  replayFixtureNow,
  replayFixturePrefix,
  replayFixtureStreamed,
} from "@/preview/replay";
import { useConversationStore } from "@/stores/conversation";
import type { SSEEvent } from "@/types/events";
import {
  FlaskConical,
  MessageSquare,
  Network,
  Play,
  Radio,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/** A preview entry: a local recording (captured from a real turn) or a committed
 *  conformance vector. Both replay through the identical path. */
interface Scenario {
  name: string;
  description: string;
  events: SSEEvent[];
  kind: "recording" | "fixture";
}

const convIdFor = (name: string) => `preview-${name}`;

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
  // Local recordings (captured from real turns) sit above the committed
  // conformance vectors; both replay through the same path. Recordings react to
  // saves/deletes so a just-captured turn shows up here without a reload.
  const recordings = useRecordings();
  const scenarios = useMemo<Scenario[]>(
    () => [
      ...recordings.map((r) => ({
        name: r.name,
        description: r.description,
        events: r.events,
        kind: "recording" as const,
      })),
      ...PREVIEW_FIXTURES.map((f) => ({
        name: f.name,
        description: f.description,
        events: f.events,
        kind: "fixture" as const,
      })),
    ],
    [recordings],
  );

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

  // Render surface (`#/preview?s=…&view=canvas`): chat (default) replays into
  // `ChatView`; canvas mounts the real canvas layout (`ConversationCanvas` +
  // `SidePanel`) so the canvas-only chrome — the team graph and the 指挥台
  // `CommandRegion` pinned atop the side panel (前端UX设计.md §6.2) — is eyeball-able
  // and shoot-gated too, not just the chat surface. URL-driven so the harness can
  // deep-link it and a human can bookmark it.
  const view = searchParams.get("view") === "canvas" ? "canvas" : "chat";
  // Preserve the current view across selection / scrubbing so flipping a scenario
  // or dragging the frame slider doesn't kick canvas back to chat.
  const withView = (params: Record<string, string>) =>
    view === "canvas" ? { ...params, view } : params;

  const stopStreamed = () => {
    cancelRef.current?.();
    cancelRef.current = null;
  };

  const select = (name: string) => {
    setSearchParams(withView({ s: name }), { replace: true });
  };

  const setView = (next: "chat" | "canvas") => {
    const params: Record<string, string> = {};
    if (selected) params.s = selected;
    if (frame !== null) params.k = String(frame);
    if (next === "canvas") params.view = next;
    setSearchParams(params, { replace: true });
  };

  const removeRecording = (name: string) => {
    deleteRecording(name);
    // If we just deleted the open one, drop `?s=` so selection falls back to the
    // first remaining scenario instead of pointing at a gone entry.
    if (selected === name) setSearchParams({}, { replace: true });
  };

  // Drag the scrubber → rewrite `?k=`. At/over the right end we drop `k` entirely
  // (terminal). The URL stays the single source of truth: the effect below re-replays
  // the prefix and data-preview-frame updates, so the screenshot harness and a human
  // scrubbing land on the exact same frame.
  const setFrame = (value: number) => {
    if (!selected) return;
    if (value >= total) {
      setSearchParams(withView({ s: selected }), { replace: true });
    } else {
      setSearchParams(
        withView({ s: selected, k: String(Math.max(1, value)) }),
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

  // Drop the synthetic slice when leaving so it never lingers as the active
  // conversation.
  useEffect(() => {
    return () => {
      useConversationStore.getState().switchConversation(null);
    };
  }, []);

  return (
    <div
      className="flex h-full min-h-0"
      data-preview-scenario={selected ?? ""}
      data-preview-frame={frame !== null ? String(frame) : "full"}
    >
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FlaskConical size={18} className="text-primary" />
          <div>
            <h1 className="text-base font-semibold text-foreground">
              前端预览
            </h1>
            <p className="text-xs text-muted-foreground">
              {scenarios.length} 个场景 · 离线回放
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {scenarios.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              未找到场景。请确认 packages/protocol-conformance/fixtures
              存在，或用标题栏「录制」按钮录一个回合。
            </p>
          ) : (
            <>
              {recordings.length > 0 && (
                <div className="mb-2">
                  <p className="px-3 py-1 text-xs font-medium text-muted-foreground">
                    录制（本地）
                  </p>
                  <ul className="space-y-0.5">
                    {recordings.map((r) => (
                      <li key={r.name} className="relative">
                        <button
                          type="button"
                          onClick={() => select(r.name)}
                          className={`w-full rounded-lg px-3 py-2 pr-9 text-left ${
                            selected === r.name
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          <span className="block truncate text-sm font-medium">
                            {r.name}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {r.description}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => removeRecording(r.name)}
                          aria-label={`删除录制 ${r.name}`}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {recordings.length > 0 && (
                <p className="px-3 py-1 text-xs font-medium text-muted-foreground">
                  内置场景
                </p>
              )}
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
            </>
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
              {/* 聊天 ⇄ 画布: flip the render surface for the SAME replayed slice, so a
                  canvas-only state (team graph + 指挥台 region) can be eyeballed offline
                  without spinning up a real multi-agent run. */}
              <div className="mr-1 flex items-center gap-0.5 rounded-lg border border-border p-0.5">
                <Button
                  variant="ghost"
                  onClick={() => setView("chat")}
                  aria-pressed={view === "chat"}
                  icon={<MessageSquare size={14} />}
                  className={
                    view === "chat"
                      ? "bg-accent text-foreground hover:bg-accent"
                      : undefined
                  }
                >
                  聊天
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setView("canvas")}
                  aria-pressed={view === "canvas"}
                  icon={<Network size={14} />}
                  className={
                    view === "canvas"
                      ? "bg-accent text-foreground hover:bg-accent"
                      : undefined
                  }
                >
                  画布
                </Button>
              </div>
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
        {current && total > 1 && (
          <div className="flex items-center gap-3 border-b border-border px-4 py-1.5">
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
              className="h-1 flex-1 cursor-pointer accent-primary"
              aria-label="流式中间帧 scrubber"
            />
            <span className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
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
        )}
        {view === "canvas" ? (
          // Mirror ConversationPage's canvas layout: the canvas takes the main
          // column and the unified SidePanel docks on the right (where the 指挥台
          // CommandRegion auto-surfaces atop the tabs). Same flat row, so the region
          // caps + self-scrolls exactly as it does in the app.
          <div className="relative flex min-h-0 flex-1">
            <ConversationCanvas />
            <SidePanel />
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ChatView />
          </div>
        )}
      </div>
    </div>
  );
}
