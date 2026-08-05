// Sandbox browser live SSE (M1) — mobile Bearer client (前端技术与架构 §七).
//
// GET …/browser/live streams EPHEMERAL browser_live_frame / browser_live_status
// envelopes (not journaled). Mirrors desktop browserLive semantics, but auth is
// `Authorization: Bearer` (never cookie credentials). session_id is always
// pinned so multi-tab frames cannot cross-wire (desktop may omit; mobile does not).

import {
  apiUrl,
  authHeader,
  fetchWithAuthRefresh,
  getTokens,
} from "@/api/client";
import { clientHeaders } from "@/lib/clientBuildInfo";

/** One live jpeg frame (envelope `type:"browser_live_frame"` payload). */
export interface BrowserLiveFrame {
  /** jpeg base64 without a data: prefix. */
  frame_b64: string;
  width: number;
  height: number;
}

/** Server live-session state (envelope `type:"browser_live_status"` payload.state). */
export type BrowserLiveState = "started" | "no_session" | "session_closed";

/** Local connection lifecycle (distinct from {@link BrowserLiveState}). */
export type BrowserLiveConnection =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface BrowserLiveHandlers {
  onFrame: (frame: BrowserLiveFrame) => void;
  onStatus: (state: BrowserLiveState) => void;
  onConnection: (connection: BrowserLiveConnection) => void;
}

/** Handle for one live attachment; `stop()` is idempotent. */
export interface BrowserLiveClient {
  stop: () => void;
}

type BrowserLiveEvent =
  | { type: "browser_live_frame"; payload: BrowserLiveFrame }
  | { type: "browser_live_status"; payload: { state: BrowserLiveState } };

type StreamOutcome = "reconnect" | "stop";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

function requireSessionId(sessionId: string): string {
  const sid = sessionId.trim();
  if (!sid) throw new Error("session_id required");
  return sid;
}

function liveUrl(conversationId: string, sessionId: string): string {
  const qs = `?session_id=${encodeURIComponent(sessionId)}`;
  return `${apiUrl(
    `/v1/conversations/${encodeURIComponent(conversationId)}/browser/live`,
  )}${qs}`;
}

/**
 * Attach to a conversation's sandbox browser live stream (pinned session).
 * Mount → start; unmount → `stop()` so idle viewers cost nothing.
 */
export function startBrowserLive(
  conversationId: string,
  sessionId: string,
  handlers: BrowserLiveHandlers,
): BrowserLiveClient {
  const sid = requireSessionId(sessionId);
  const url = liveUrl(conversationId, sid);

  let running = true;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  function emitConnection(connection: BrowserLiveConnection): void {
    if (running) handlers.onConnection(connection);
  }

  function handleFrame(frame: string): void {
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    let event: BrowserLiveEvent;
    try {
      event = JSON.parse(dataLines.join("\n")) as BrowserLiveEvent;
    } catch {
      return;
    }
    if (!running) return;
    if (event.type === "browser_live_frame") {
      handlers.onFrame(event.payload);
    } else if (event.type === "browser_live_status") {
      handlers.onStatus(event.payload.state);
    }
  }

  async function runStream(signal: AbortSignal): Promise<StreamOutcome> {
    let response: Response;
    try {
      // Shared 401 policy (refresh once + replay; still-401 clears tokens) —
      // same as stream/midFlight; avoid reconnect-loop that never clears.
      response = await fetchWithAuthRefresh(() =>
        fetch(url, {
          method: "GET",
          headers: {
            ...clientHeaders(),
            Accept: "text/event-stream",
            ...authHeader(),
          },
          signal,
        }),
      );
    } catch {
      return "reconnect";
    }

    if (response.status === 401) {
      // Policy already tried refresh+replay (and cleared on still-401).
      // Dead session → stop; transient refresh failure → keep tokens and retry.
      if (!getTokens()) return "stop";
      return "reconnect";
    }
    if (!response.ok || !response.body) return "reconnect";

    attempts = 0;
    emitConnection("open");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) handleFrame(frame);
      }
    } catch {
      return "reconnect";
    }
    return "reconnect";
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer !== null) return;
    emitConnection("reconnecting");
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
    attempts += 1;
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        void connect();
      },
      delay + Math.random() * 500,
    );
  }

  async function connect(): Promise<void> {
    if (!running) return;
    const ac = new AbortController();
    controller = ac;
    let outcome: StreamOutcome = "reconnect";
    try {
      outcome = await runStream(ac.signal);
    } catch {
      outcome = "reconnect";
    }
    if (ac.signal.aborted || !running) return;
    if (outcome === "stop") {
      running = false;
      return;
    }
    scheduleReconnect();
  }

  emitConnection("connecting");
  void connect();

  return {
    stop(): void {
      running = false;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      controller?.abort();
      controller = null;
    },
  };
}
