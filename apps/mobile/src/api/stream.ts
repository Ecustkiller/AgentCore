import { apiUrl, authHeader, refreshTokens } from "@/api/client";
import type { MessageAttachment } from "@/lib/attachments";
// SSE transport for the mobile client (手机端落地设计 P1).
//
// The backend streams a turn as a POST returning text/event-stream (api/sse.py):
// frames are `event: <type>\ndata: {type,timestamp,payload}\n\n`, with `: ping`
// heartbeat comments. Because it's a fetch-streamed POST (not EventSource), the bearer
// header rides the request directly — the key reason bearer + SSE works on mobile.
//
// This layer is PURE TRANSPORT: it parses each `data:` frame into a typed SSEEvent and
// hands it to `onEvent`. All interpretation lives in the conformance-checked fold
// (src/protocol/fold.ts) — never re-fold here (cross-platform-frontend.mdc §四).
//
// 执行与请求解耦 (C1 · slice 1a/1b): a client disconnect no longer cancels a server
// turn — it runs detached and persists. So there are three SSE entry points that all
// fold through the SAME shape: `streamMessage` (fresh send), `attachStream` (rejoin a
// still-live run after a drop / on reopen), and `resumeStream` (continue a durably
// paused turn). An explicit 停止 is a separate JSON call (api/turn.ts).
import type { CheckpointDecision, SSEEvent } from "@agentcore/contract-types";

/** Read an SSE response body to completion, delivering each parsed `data:` frame to
 *  `onEvent`. `event:` lines and `:` heartbeats are ignored (the data JSON already
 *  carries the type). Throws if the response has no readable body. */
async function pumpSSE(
  response: Response,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无响应流");

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; keep the trailing partial in buffer.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as SSEEvent);
        } catch {
          // Skip a malformed/partial frame; the next read completes it.
        }
      }
    }
  }
}

/** Run a fetch with the shared 401 policy (refresh once, replay). The SSE channels read
 *  the body themselves, so they can't ride apiFetch — they mirror its policy here. */
async function sseFetch(doFetch: () => Promise<Response>): Promise<Response> {
  let response = await doFetch();
  if (response.status === 401 && (await refreshTokens())) {
    response = await doFetch();
  }
  return response;
}

/**
 * Stream a freshly-sent user message, delivering each parsed SSE event to `onEvent`.
 * Throws on a transport failure (non-2xx / no body) or when the passed `signal` aborts
 * (the user's 停止); backend `error` events arrive as normal events for the fold.
 *
 * Since 执行与请求解耦 (slice 1a) a dropped connection no longer kills the turn — it runs
 * detached — so a mid-stream throw means "rejoin it" (attachStream), not "resend".
 *
 * `attachments` carry extracted file text alongside the prompt (composer 附件); omitted from
 * the body when empty so a plain turn keeps the exact prior shape.
 */
export async function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
  attachments?: MessageAttachment[],
): Promise<void> {
  const path = `/v1/conversations/${conversationId}/messages`;
  const payload: Record<string, unknown> = { content };
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  const response = await sseFetch(() =>
    fetch(apiUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeader(),
      },
      body: JSON.stringify(payload),
      signal,
    }),
  );
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
  await pumpSSE(response, onEvent);
}

/** Outcome of a re-attach attempt (执行与请求解耦 C1 · slice 1b). */
export type AttachOutcome =
  /** A live run was found; its transcript-so-far was replayed and the stream tailed
   *  to completion (or until the connection dropped — the caller distinguishes via the
   *  thrown error). */
  | "attached"
  /** No run is live for the conversation (204) — already finished / never started /
   *  suspended at a checkpoint. The caller falls back to the persisted transcript
   *  (reload) or durable resume. */
  | "none";

/**
 * Re-attach to a conversation's in-flight turn and 续看 it live (C1 · slice 1b).
 *
 * Since a disconnect no longer cancels a turn, a client that dropped (network blip) or
 * reopened the app can rejoin the live run: the backend replays the transcript so far
 * (coalesced) then tails new events, all in the SAME shape as the original stream, so
 * the caller folds it through the one `fold`. Returns "none" on a 204 (nothing live to
 * rejoin); throws on a transport drop while attached (retriable) or on auth.
 */
export async function attachStream(
  conversationId: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<AttachOutcome> {
  const path = `/v1/conversations/${conversationId}/stream`;
  const response = await sseFetch(() =>
    fetch(apiUrl(path), {
      method: "GET",
      headers: { Accept: "text/event-stream", ...authHeader() },
      signal,
    }),
  );
  if (response.status === 204) return "none";
  if (!response.ok) throw new Error(`续连失败 (${response.status})`);
  await pumpSSE(response, onEvent);
  return "attached";
}

/** The user's settlement of a durably-paused turn (mirrors backend ResumeTurnRequest).
 *  `note` steers an `adjust`; `selected` carries ask_user picks (ignored for plan_review). */
export interface ResumeTurnBody {
  decision: CheckpointDecision;
  note: string;
  selected: string[];
}

/**
 * Continue a durably-paused turn via SSE (结构化挂起 2b `POST .../resume`).
 *
 * The turn paused at a plan_review / ask_user checkpoint and lost its live stream
 * (disconnect / restart); only its persisted frame survived. The backend claims the
 * frame (atomic — a second/stale call 404s) and drives the rest of the turn on a fresh
 * SSE, folded through the same path as a send. Throws on transport / claim failure.
 */
export async function resumeStream(
  conversationId: string,
  messageId: string,
  body: ResumeTurnBody,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/v1/conversations/${conversationId}/messages/${messageId}/resume`;
  const response = await sseFetch(() =>
    fetch(apiUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeader(),
      },
      body: JSON.stringify(body),
      signal,
    }),
  );
  if (!response.ok) throw new Error(`继续失败 (${response.status})`);
  await pumpSSE(response, onEvent);
}
