// Sandbox browser takeover + input (M2) — mobile Bearer client (前端技术与架构 §七).
//
// REST siblings of browserLive SSE:
//   POST …/browser/takeover {action, session_id}
//   POST …/browser/input    {events, session_id}
// Outcomes ride 200 + `reason` (not HTTP error codes). Auth is Bearer via apiFetch
// (never cookie credentials). session_id is always pinned — fixes the desktop
// drift where sendBrowserInput may omit it.

import { apiFetch } from "@/api/client";

/**
 * One user input event in **frame-pixel space** (not display coords). Batched into
 * `…/browser/input`. Three kinds: mouse / key / text (IME fallback).
 */
export type BrowserInputEvent =
  | {
      kind: "mouse";
      type: "down" | "up" | "move" | "wheel";
      x: number;
      y: number;
      button?: number;
      delta_x?: number;
      delta_y?: number;
      click_count?: number;
    }
  | {
      kind: "key";
      type: "down" | "up";
      key: string;
      code?: string;
      modifiers?: string[];
    }
  | { kind: "text"; text: string };

/** POST …/browser/takeover response reason (success and failure both HTTP 200). */
export type BrowserTakeoverReason =
  | "started"
  | "ended"
  | "already_active"
  | "no_session"
  | "not_active";

/** POST …/browser/takeover 200 body. */
export interface BrowserTakeoverState {
  active: boolean;
  reason: BrowserTakeoverReason;
  record_id?: string | null;
  started_at?: string | null;
  session_id?: string | null;
}

/** Thrown when start fails by reason (not started / already_active). */
export class TakeoverStartError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "TakeoverStartError";
    this.reason = reason;
  }
}

function requireSessionId(sessionId: string): string {
  const sid = sessionId.trim();
  if (!sid) throw new Error("session_id required");
  return sid;
}

function takeoverPath(conversationId: string): string {
  return `/v1/conversations/${encodeURIComponent(conversationId)}/browser/takeover`;
}

function inputPath(conversationId: string): string {
  return `/v1/conversations/${encodeURIComponent(conversationId)}/browser/input`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`请求失败 (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * Start takeover for a pinned session. `started` | `already_active` succeed;
 * other reasons throw {@link TakeoverStartError}.
 */
export async function startBrowserTakeover(
  conversationId: string,
  sessionId: string,
): Promise<BrowserTakeoverState> {
  const sid = requireSessionId(sessionId);
  const state = await postJson<BrowserTakeoverState>(
    takeoverPath(conversationId),
    {
      action: "start",
      session_id: sid,
    },
  );
  if (state.reason === "started" || state.reason === "already_active") {
    return state;
  }
  throw new TakeoverStartError(state.reason);
}

/** End takeover (idempotent). */
export async function endBrowserTakeover(
  conversationId: string,
  sessionId: string,
): Promise<void> {
  const sid = requireSessionId(sessionId);
  await postJson<BrowserTakeoverState>(takeoverPath(conversationId), {
    action: "end",
    session_id: sid,
  });
}

/**
 * Batch-inject input events (coords already in frame space). Empty batch is a no-op.
 * Always pins `session_id`.
 */
export async function sendBrowserInput(
  conversationId: string,
  sessionId: string,
  events: BrowserInputEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const sid = requireSessionId(sessionId);
  await postJson<{ injected?: number }>(inputPath(conversationId), {
    events,
    session_id: sid,
  });
}

/** Acceptance alias for {@link sendBrowserInput}. */
export const sendInput = sendBrowserInput;

/** Map a start failure to a short zh string for UI. */
export function takeoverStartErrorMessage(err: unknown): string {
  const reason =
    err instanceof TakeoverStartError
      ? err.reason
      : typeof err === "string"
        ? err
        : undefined;
  switch (reason) {
    case "no_session":
      return "当前没有进行中的浏览器会话";
    case "already_active":
      return "浏览器已被接管";
    case "not_active":
      return "当前没有进行中的接管";
    default:
      return "无法接管浏览器，请重试";
  }
}

/** Display rect subset of `getBoundingClientRect`. */
export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map display (clientX/clientY) → frame-pixel space under object-contain
 * (scale + letterbox padding), then clamp and round.
 */
export function toFrameSpace(
  clientX: number,
  clientY: number,
  rect: DisplayRect,
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number } {
  if (frameWidth <= 0 || frameHeight <= 0) return { x: 0, y: 0 };
  const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight);
  if (!(scale > 0)) return { x: 0, y: 0 };
  const renderedW = frameWidth * scale;
  const renderedH = frameHeight * scale;
  const padX = (rect.width - renderedW) / 2;
  const padY = (rect.height - renderedH) / 2;
  const fx = (clientX - rect.left - padX) / scale;
  const fy = (clientY - rect.top - padY) / scale;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return {
    x: Math.round(clamp(fx, frameWidth)),
    y: Math.round(clamp(fy, frameHeight)),
  };
}

/** Extract modifier names from a keyboard event (omit when empty). */
export function modifiersOf(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string[] | undefined {
  const mods: string[] = [];
  if (e.altKey) mods.push("alt");
  if (e.ctrlKey) mods.push("ctrl");
  if (e.metaKey) mods.push("meta");
  if (e.shiftKey) mods.push("shift");
  return mods.length > 0 ? mods : undefined;
}

export interface InputBatcher {
  push: (event: BrowserInputEvent) => void;
  flush: () => void;
  stop: () => void;
}

const DEFAULT_FLUSH_MS = 60;

/**
 * Coalesce high-frequency input into timed batches for `…/browser/input`.
 * Consecutive mouse moves keep only the latest; commit events flush immediately.
 * Send failures are swallowed (stale replay is worse). Buffer never persists.
 */
export function createInputBatcher(
  send: (events: BrowserInputEvent[]) => Promise<void>,
  flushMs: number = DEFAULT_FLUSH_MS,
): InputBatcher {
  let buffer: BrowserInputEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    void send(batch).catch(() => {});
  }

  function schedule(): void {
    if (timer !== null || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
  }

  function isCommit(event: BrowserInputEvent): boolean {
    if (event.kind === "text") return true;
    if (event.kind === "key") return event.type === "up";
    return event.type === "up" || event.type === "wheel";
  }

  return {
    push(event) {
      if (stopped) return;
      const last = buffer[buffer.length - 1];
      if (
        event.kind === "mouse" &&
        event.type === "move" &&
        last?.kind === "mouse" &&
        last.type === "move"
      ) {
        buffer[buffer.length - 1] = event;
      } else {
        buffer.push(event);
      }
      if (isCommit(event)) flush();
      else schedule();
    },
    flush,
    stop() {
      stopped = true;
      flush();
    },
  };
}
