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
import type { SSEEvent } from "@agentcore/contract-types";
import { apiFetch, apiUrl, authHeader, refreshTokens } from "@/api/client";

/** Create a fresh cloud conversation and return its id (skeleton: no folder/mode). */
export async function createConversation(title?: string): Promise<string> {
  const res = await apiFetch("/v1/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title ?? null }),
  });
  if (!res.ok) throw new Error(`创建会话失败 (${res.status})`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * Stream a user message and deliver each parsed SSE event to `onEvent`. Mirrors
 * apiFetch's 401 policy (refresh once, replay) since it reads the body itself. Throws
 * on a transport failure (non-2xx / no body); backend `error` events arrive as normal
 * events for the fold to surface.
 */
export async function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (event: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/v1/conversations/${conversationId}/messages`;
  const doFetch = () =>
    fetch(apiUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeader(),
      },
      body: JSON.stringify({ content }),
      signal,
    });

  let response = await doFetch();
  if (response.status === 401 && (await refreshTokens())) {
    response = await doFetch();
  }
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);

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
        // Only `data:` lines carry the event JSON; `event:` lines and `:` heartbeats
        // are ignored (the data JSON already includes the type).
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
