import { dispatchSSEEvent, flushPendingContent } from "@/services/sse/dispatch";
import { useConversationStore } from "@/stores/conversation";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import type { SSEEvent } from "@/types/events";

/**
 * Replay a recorded SSE event stream into a conversation slice so the real chat UI
 * renders the resulting AI state — zero backend, zero LLM, zero token cost. This
 * mirrors the production live path (`pumpSSE` → `dispatchSSEEvent`), so what shows
 * up is exactly what a real turn produces; the events are the same golden vectors
 * the conformance gate runs, so the preview can never drift from production.
 */
function seedSlice(conversationId: string, userPrompt?: string): void {
  const store = useConversationStore.getState();
  // Fresh slice each time so re-playing the same fixture starts clean.
  store.dropConversationRuntime(conversationId);
  // 挂起即收口 (②): a paused fixture's message_end(paused) surfaces a resume entry into
  // the (conversation-scoped) paused-turns sibling store; reset it alongside the runtime
  // so a re-replay (StrictMode's dev double-invoke, or re-cutting a frame) starts clean
  // instead of stacking a stale resume card from the prior run's assistant message.
  usePausedTurnStore.getState().clear(conversationId);
  store.switchConversation(conversationId);
  if (userPrompt) {
    store.addMessage(
      {
        id: crypto.randomUUID(),
        role: "user",
        content: userPrompt,
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      conversationId,
    );
  }
}

/** Replay the whole stream at once → the turn's terminal AI state. */
export function replayFixtureNow(
  conversationId: string,
  events: SSEEvent[],
  userPrompt?: string,
): void {
  seedSlice(conversationId, userPrompt);
  for (const event of events) {
    dispatchSSEEvent(event, { conversationId, source: "server" });
  }
  // content_delta is rAF-buffered and a paused fixture never emits message_end, so
  // flush to land the final text on the bubble synchronously.
  flushPendingContent(conversationId);
}

/**
 * Replay only the first `count` events → a mid-stream (in-progress) frame, e.g.
 * a tool still running or a run started-but-not-completed. Drives the screenshot
 * harness's frame scrubber and the `#/preview?s=…&k=<count>` deep link, so the
 * streaming intermediate states are eyeball-able and gate-able, not just terminal.
 */
export function replayFixturePrefix(
  conversationId: string,
  events: SSEEvent[],
  count: number,
  userPrompt?: string,
): void {
  seedSlice(conversationId, userPrompt);
  const n = Math.max(0, Math.min(count, events.length));
  for (let i = 0; i < n; i++) {
    dispatchSSEEvent(events[i], { conversationId, source: "server" });
  }
  // content_delta is rAF-buffered; flush so a paused mid-stream frame lands its
  // partial text synchronously before the harness screenshots.
  flushPendingContent(conversationId);
}

/**
 * Replay with a per-event delay so the turn animates in like a live stream.
 * Returns a canceller (call on unmount / when switching fixtures).
 */
export function replayFixtureStreamed(
  conversationId: string,
  events: SSEEvent[],
  userPrompt?: string,
  stepMs = 28,
): () => void {
  seedSlice(conversationId, userPrompt);
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let i = 0;
  const tick = (): void => {
    if (cancelled) return;
    if (i >= events.length) {
      flushPendingContent(conversationId);
      return;
    }
    dispatchSSEEvent(events[i++], { conversationId, source: "server" });
    timer = setTimeout(tick, stepMs);
  };
  tick();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    flushPendingContent(conversationId);
  };
}
