import { StreamError } from "@/lib/errors";
import { notifyUnauthorized, tryRefresh } from "@/services/api";
import type { PlanReviewUserDecision } from "@/services/planReview";
import { useApprovalStore } from "@/stores/approvals";
import { getRuntime } from "@/stores/conversation";
import type { SSEEvent } from "@/types/events";
import { dispatchSSEEvent, flushPendingContent } from "./sse/dispatch";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

/** Build a {@link StreamError} from a non-OK response. A refused turn (e.g. 429
 * for quota / rate limit) arrives as a plain JSON `{error:{code,message}}` body
 * with a `Retry-After` header — not an SSE stream — so pull those out for precise
 * UI phrasing. Falls back to status-only when the body isn't the expected shape. */
async function streamErrorFromResponse(
  response: Response,
): Promise<StreamError> {
  let code: string | undefined;
  let serverMessage: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = body.error?.code;
    serverMessage = body.error?.message;
  } catch {
    /* non-JSON body — keep status-only phrasing */
  }
  const header = Number(response.headers.get("Retry-After"));
  return new StreamError("http", response.status, {
    code,
    serverMessage,
    retryAfter: Number.isFinite(header) && header > 0 ? header : undefined,
  });
}

/**
 * Drain an SSE response body, routing every `data:` event through
 * `dispatchSSEEvent`. Shared by the POST turn channel (send / regenerate /
 * resume) and the GET re-attach channel (实时重连续看 C1 · slice 1b) — every SSE
 * consumer folds events through the one dispatch, so a live stream, a reload, and
 * a reconnect all rebuild identical state.
 *
 * Applies the idle stall watchdog: the backend heart-beats every ~15s while a
 * turn thinks, so a live connection always delivers bytes; total silence for the
 * timeout means the socket is dead (server / proxy dropped it), so we cancel and
 * raise a retriable network error rather than hang. This is an *idle* timeout,
 * never a total-duration cap — a long turn that keeps streaming (or just
 * heart-beating) is never cut off.
 */
async function pumpSSE(
  response: Response,
  conversationId: string,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  const IDLE_TIMEOUT_MS = 60_000;
  const readChunk = (): ReturnType<typeof reader.read> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new StreamError("network"));
      }, IDLE_TIMEOUT_MS);
      reader.read().then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

  while (true) {
    const { done, value } = await readChunk();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as SSEEvent;
        dispatchSSEEvent(event, { conversationId });
      } catch {
        /* malformed event — skip */
      }
    }
  }
}

/** Outcome of a re-attach attempt (执行与请求解耦 C1 · slice 1b). */
export type AttachOutcome = "attached" | "none";

/**
 * Re-attach to a conversation's in-flight turn and 续看 it live (C1 · slice 1b).
 */
export async function attachConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<AttachOutcome> {
  const doFetch = () =>
    fetch(`${BASE_URL}/v1/conversations/${conversationId}/stream`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/event-stream" },
      signal,
    });

  try {
    let response = await doFetch();
    if (response.status === 401) {
      if (await tryRefresh()) {
        response = await doFetch();
      }
      if (response.status === 401) {
        notifyUnauthorized();
        throw new StreamError("auth");
      }
    }
    if (response.status === 204) return "none";
    if (!response.ok) {
      throw await streamErrorFromResponse(response);
    }

    await pumpSSE(response, conversationId);

    if (getRuntime(conversationId).isGenerating) {
      throw new StreamError("network");
    }
    return "attached";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof StreamError) throw err;
    throw new StreamError("network");
  } finally {
    flushPendingContent(conversationId);
  }
}

/**
 * POST to an SSE endpoint and route every event through `dispatchSSEEvent`.
 */
async function runMessageStream(
  path: string,
  body: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  useApprovalStore.getState().clear(conversationId);

  const doFetch = () =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
      signal,
    });

  try {
    let response = await doFetch();
    if (response.status === 401) {
      if (await tryRefresh()) {
        response = await doFetch();
      }
      if (response.status === 401) {
        notifyUnauthorized();
        throw new StreamError("auth");
      }
    }

    if (!response.ok) {
      throw await streamErrorFromResponse(response);
    }

    await pumpSSE(response, conversationId);

    if (getRuntime(conversationId).isGenerating) {
      throw new StreamError("network");
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof StreamError) throw err;
    throw new StreamError("network");
  } finally {
    flushPendingContent(conversationId);
  }
}

/** 发送给后端的附件载荷（含提取出的正文）。 */
export interface OutgoingAttachment {
  name: string;
  path: string;
  text: string;
  truncated: boolean;
  kind?: "file" | "dir" | "conversation";
  conversation_id?: string;
}

export interface StreamConversationOptions {
  conversationId: string;
  content: string;
  attachments?: OutgoingAttachment[];
  signal?: AbortSignal;
}

/** Send a user message and consume the SSE response stream. */
export async function streamConversation({
  conversationId,
  content,
  attachments,
  signal,
}: StreamConversationOptions): Promise<void> {
  const payload: Record<string, unknown> = { content };
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages`,
    JSON.stringify(payload),
    conversationId,
    signal,
  );
}

export interface RegenerateConversationOptions {
  conversationId: string;
  messageId: string;
  content?: string;
  signal?: AbortSignal;
}

export async function regenerateConversation({
  conversationId,
  messageId,
  content,
  signal,
}: RegenerateConversationOptions): Promise<void> {
  const body = JSON.stringify(content !== undefined ? { content } : {});
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages/${messageId}/regenerate`,
    body,
    conversationId,
    signal,
  );
}

export interface ResumeConversationOptions {
  conversationId: string;
  messageId: string;
  decision: PlanReviewUserDecision;
  note: string;
  selected?: string[];
  signal?: AbortSignal;
}

export async function resumeConversation({
  conversationId,
  messageId,
  decision,
  note,
  selected = [],
  signal,
}: ResumeConversationOptions): Promise<void> {
  const body = JSON.stringify({ decision, note, selected });
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages/${messageId}/resume`,
    body,
    conversationId,
    signal,
  );
}

// Re-export SSE dispatch surface (shared by cloud + sidecar paths).
export {
  dispatchSSEEvent,
  flushPendingContent,
} from "./sse/dispatch";
