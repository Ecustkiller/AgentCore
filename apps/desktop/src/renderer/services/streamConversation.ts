import { clientHeaders } from "@/lib/clientBuildInfo";
import { StreamError } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import {
  BASE_URL,
  getCsrfHeaders,
  notifyUnauthorized,
  tryRefresh,
} from "@/services/api";
import type { PlanReviewUserDecision } from "@/services/planReview";
import {
  dispatchSSEEvent,
  flushPendingContent,
  flushPendingFrames,
} from "@/services/sse/dispatch";
import { traceTurnMilestone } from "@/services/turnTrace";
import { reconcileQueuedTurns } from "@/services/turns/reconcileQueuedTurns";
import {
  claimPrimaryStream,
  releasePrimaryStream,
} from "@/services/turns/streamOwnership";
import { getRuntime } from "@/stores/conversation";
import {
  enterTurnStreaming,
  throwIfCannotOpenStream,
} from "@/stores/conversation/turnPhaseActions";
import { useExecutionStore } from "@/stores/execution";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import type { SSEEvent } from "@/types/events";
import { unstable_batchedUpdates } from "react-dom";

/** SSE comment after attach journal replay (+ hot re-hang); mirrors server
 * ``sse._ATTACH_CAUGHT_UP``. Not an EventType — pump-level only. */
export const ATTACH_CAUGHT_UP_COMMENT = "attach-caught-up";

/** Max wait for response headers (connect + server accept). Distinct from {@link pumpSSE}'s
 *  idle timeout, which only applies once the body is streaming. */
const CONNECT_TIMEOUT_MS = 30_000;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** `fetch` with a connect-phase ceiling; user `signal` abort still propagates as AbortError.
 * 同步拒绝已 abort 的 signal，避免连接超时窗口内仍发出请求。 */
async function fetchWithConnectTimeout(
  init: (signal: AbortSignal) => Promise<Response>,
  userSignal?: AbortSignal,
): Promise<Response> {
  if (userSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const fetchAc = new AbortController();
  const timer = setTimeout(() => fetchAc.abort(), CONNECT_TIMEOUT_MS);
  const onUserAbort = () => fetchAc.abort();
  userSignal?.addEventListener("abort", onUserAbort);
  try {
    return await init(fetchAc.signal);
  } catch (err) {
    if (isAbortError(err)) {
      if (userSignal?.aborted) throw err;
      throw new StreamError("network");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener("abort", onUserAbort);
  }
}

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
      detail?: { code?: string; message?: string } | string;
    };
    code = body.error?.code;
    serverMessage = body.error?.message;
    if (!code && typeof body.detail === "object" && body.detail) {
      code = body.detail.code;
      serverMessage = body.detail.message ?? serverMessage;
    }
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

/** Latest journal seq seen on this conversation's SSE (for Last-Event-ID). */
const lastEventIds = new Map<string, string>();

/**
 * Force the active SSE pump for ``conversationId`` to die as a transport drop
 * (same {@link StreamError} ``network`` path as ``sse.idle_stall``), so the turn
 * catcher rejoins rather than treating it as an honest user stop.
 *
 * Used when a cloud workspace settle exhausts transient retries — the same blip
 * often strands later ``workspace_op_required`` frames on a half-dead pump.
 */
const pumpForceDrop = new Map<string, () => void>();

export function forceSseTransportDrop(conversationId: string): boolean {
  const drop = pumpForceDrop.get(conversationId);
  if (!drop) return false;
  drop();
  return true;
}

/** Read the cursor used for precise stream resume. */
export function peekLastEventId(conversationId: string): string | undefined {
  return lastEventIds.get(conversationId);
}

export function clearLastEventId(conversationId: string): void {
  lastEventIds.delete(conversationId);
}

/**
 * Drain an SSE response body, routing every `data:` event through
 * `dispatchSSEEvent` (or a custom ``onEvent``). Shared by the POST turn channel
 * (send / regenerate / resume / midFlight) and the GET re-attach channel
 * (实时重连续看 C1 · slice 1b) — every SSE consumer folds events through the one
 * dispatch, so a live stream, a reload, and a reconnect all rebuild identical state.
 *
 * Applies the idle stall watchdog: the backend heart-beats every ~15s while a
 * turn thinks, so a live connection always delivers bytes; total silence for the
 * timeout means the socket is dead (server / proxy dropped it), so we cancel and
 * raise a retriable network error rather than hang. This is an *idle* timeout,
 * never a total-duration cap — a long turn that keeps streaming (or just
 * heart-beating) is never cut off.
 *
 * Tracks the latest SSE ``id:`` (journal seq) per conversation for ``Last-Event-ID``
 * resume (流式回复持久化 P3).
 *
 * ``onComment`` receives SSE comment payloads (text after ``:``), used by attach
 * catch-up (``attach-caught-up``) — heartbeats (``ping``) are ignored by callers.
 */
export async function pumpSseBody(
  response: Response,
  conversationId: string,
  onEvent?: (event: SSEEvent) => void,
  onComment?: (comment: string) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  // 缺省 = 唯一 dispatch 通道（live / reload / reconnect）；调用方可注入 onEvent
  //（如 midFlight 在 turn_queue_started 时补插用户泡、缓冲至主路空闲再 fold）。
  const deliver =
    onEvent ??
    ((event: SSEEvent) =>
      dispatchSSEEvent(event, { conversationId, source: "server" }));

  const decoder = new TextDecoder();
  let buffer = "";
  /** Most recent SSE ``id:`` in the current frame (reset each blank-line frame). */
  let frameId: string | null = null;

  const IDLE_TIMEOUT_MS = 60_000;
  let pendingReject: ((err: unknown) => void) | null = null;

  const forceTransportDrop = (): void => {
    logEvent("warn", "sse.forced_transport_drop", {
      conversation_id: conversationId,
    });
    void reader.cancel().catch(() => {});
    const reject = pendingReject;
    pendingReject = null;
    reject?.(new StreamError("network"));
  };
  pumpForceDrop.set(conversationId, forceTransportDrop);

  const readChunk = (): ReturnType<typeof reader.read> =>
    new Promise((resolve, reject) => {
      pendingReject = reject;
      const timer = setTimeout(() => {
        if (pendingReject === reject) pendingReject = null;
        // L3：空闲 60s 无字节 → 泵自杀；此后 workspace_op 可能无人履行。
        logEvent("warn", "sse.idle_stall", {
          conversation_id: conversationId,
          idle_timeout_ms: IDLE_TIMEOUT_MS,
        });
        void reader.cancel().catch(() => {});
        reject(new StreamError("network"));
      }, IDLE_TIMEOUT_MS);
      reader.read().then(
        (r) => {
          clearTimeout(timer);
          if (pendingReject === reject) pendingReject = null;
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          if (pendingReject === reject) pendingReject = null;
          reject(e);
        },
      );
    });

  try {
    while (true) {
      const { done, value } = await readChunk();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          frameId = null;
          continue;
        }
        if (line.startsWith(":")) {
          // Heartbeat (``: ping``) or attach boundary (``: attach-caught-up``).
          onComment?.(line.slice(1).trim());
          continue;
        }
        if (line.startsWith("id:")) {
          const id = line.slice(3).trim();
          if (id) {
            frameId = id;
            lastEventIds.set(conversationId, id);
          }
          continue;
        }
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6)) as SSEEvent;
          if (frameId) lastEventIds.set(conversationId, frameId);
          deliver(event);
        } catch {
          /* malformed event — skip */
        }
      }
    }
  } finally {
    if (pumpForceDrop.get(conversationId) === forceTransportDrop) {
      pumpForceDrop.delete(conversationId);
    }
  }
}

/** Apply buffered attach catch-up events in one React batch (avoid per-frame worker
 * running→completed paint during clear-then-fold replay). Clears any bridge
 * hydrateFromJournal first so journal frames are not double-folded. */
function flushAttachCatchUp(conversationId: string, events: SSEEvent[]): void {
  unstable_batchedUpdates(() => {
    const last = getRuntime(conversationId).messages.at(-1);
    if (last?.role === "assistant") {
      const { clearExecution } = useExecutionStore.getState();
      clearExecution(last.id);
      if (last.serverMessageId && last.serverMessageId !== last.id) {
        clearExecution(last.serverMessageId);
      }
    }
    for (const event of events) {
      dispatchSSEEvent(event, { conversationId, source: "server" });
    }
    flushPendingContent(conversationId);
    flushPendingFrames(conversationId);
  });
}

/** Outcome of a re-attach attempt (执行与请求解耦 C1 · slice 1b). */
export type AttachOutcome = "attached" | "none";

/**
 * Re-attach to a conversation's in-flight turn and 续看 it live (C1 · slice 1b).
 *
 * Always sends ``Last-Event-ID`` (last journal seq, or ``0`` when none) so the
 * backend takes the journal-backed full-turn replay path (流式回复持久化 §3.6 ·
 * P3). Callers that clear-then-fold (``rejoinLiveTurn``) truncate the bubble /
 * process / execution before attach — the replay segment folds into the empty
 * placeholder.
 *
 * Catch-up: buffer journal replay (+ hot re-hang) until ``: attach-caught-up``,
 * then one-shot fold so already-completed workers do not paint running→completed
 * again on refresh. Older servers without the comment flush the buffer when the
 * stream ends (degraded: still one paint, no live boundary).
 */
export async function attachConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<AttachOutcome> {
  throwIfCannotOpenStream(conversationId, signal);
  enterTurnStreaming(conversationId);
  const primaryToken = claimPrimaryStream(conversationId);

  const doFetch = (signal: AbortSignal) => {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...clientHeaders(),
    };
    // Always present → journal-backed full replay (header value observational).
    headers["Last-Event-ID"] = lastEventIds.get(conversationId) ?? "0";
    return fetch(`${BASE_URL}/v1/conversations/${conversationId}/stream`, {
      method: "GET",
      credentials: "include",
      headers,
      signal,
    });
  };

  try {
    let response = await fetchWithConnectTimeout(doFetch, signal);
    if (response.status === 401) {
      const outcome = await tryRefresh();
      if (outcome === "renewed") {
        response = await fetchWithConnectTimeout(doFetch, signal);
      } else if (outcome === "auth_dead") {
        notifyUnauthorized();
        throw new StreamError("auth");
      } else {
        throw new StreamError("network");
      }
      if (response.status === 401) {
        notifyUnauthorized();
        throw new StreamError("auth");
      }
    }
    if (response.status === 204) {
      // 无 live turn 仍对账：清幽灵条 / 对齐他端仍在队的项。
      void reconcileQueuedTurns(conversationId);
      return "none";
    }
    if (!response.ok) {
      throw await streamErrorFromResponse(response);
    }

    // SSE 重连成功：队列 EPHEMERAL 可能已漏；GET 权威刷新条。
    void reconcileQueuedTurns(conversationId);

    const catchUp: SSEEvent[] = [];
    let catchingUp = true;
    await pumpSseBody(
      response,
      conversationId,
      (event) => {
        if (catchingUp) {
          catchUp.push(event);
          return;
        }
        dispatchSSEEvent(event, { conversationId, source: "server" });
      },
      (comment) => {
        if (!catchingUp) return;
        if (comment !== ATTACH_CAUGHT_UP_COMMENT) return;
        catchingUp = false;
        flushAttachCatchUp(conversationId, catchUp);
        catchUp.length = 0;
      },
    );
    // Legacy server: no caught-up comment — flush whatever we buffered (whole stream).
    if (catchingUp && catchUp.length > 0) {
      flushAttachCatchUp(conversationId, catchUp);
    }

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
    flushPendingFrames(conversationId);
    releasePrimaryStream(conversationId, primaryToken);
  }
}

/**
 * POST to an SSE endpoint and route every event through `dispatchSSEEvent`.
 *
 * 发送即有流：本端点恒返回 SSE（含 in-flight 时先发 ``turn_queued`` 再同连接
 * 续流；插话（经典/协调）为 ``user_interjection`` 短确认流）。不再有 HTTP 202 JSON。
 */
async function runMessageStream(
  path: string,
  body: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  clearInteractionPrompts(conversationId);
  throwIfCannotOpenStream(conversationId, signal);
  enterTurnStreaming(conversationId);
  const primaryToken = claimPrimaryStream(conversationId);

  const doFetch = (signal: AbortSignal) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...clientHeaders(),
        ...getCsrfHeaders("POST"),
      },
      body,
      signal,
    });

  try {
    traceTurnMilestone(conversationId, "fetch_start", { path });
    let response = await fetchWithConnectTimeout(doFetch, signal);
    traceTurnMilestone(conversationId, "fetch_response", {
      status: response.status,
      ok: response.ok,
    });
    if (response.status === 401) {
      const outcome = await tryRefresh();
      if (outcome === "renewed") {
        response = await fetchWithConnectTimeout(doFetch, signal);
      } else if (outcome === "auth_dead") {
        notifyUnauthorized();
        throw new StreamError("auth");
      } else {
        throw new StreamError("network");
      }
      if (response.status === 401) {
        notifyUnauthorized();
        throw new StreamError("auth");
      }
    }

    if (!response.ok) {
      throw await streamErrorFromResponse(response);
    }
    // 发送即有流：成功体必须是 SSE。202 在 fetch 里仍算 ok，但契约已退役——
    // 显式失败，避免把 JSON 体当 SSE 静默读完再误判断流。
    if (response.status === 202) {
      throw new StreamError("http", 202, {
        serverMessage: "服务端仍返回已退役的 202 排队受理，请升级后端后再试",
      });
    }

    await pumpSseBody(response, conversationId);

    if (getRuntime(conversationId).isGenerating) {
      throw new StreamError("network");
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof StreamError) throw err;
    throw new StreamError("network");
  } finally {
    flushPendingContent(conversationId);
    flushPendingFrames(conversationId);
    releasePrimaryStream(conversationId, primaryToken);
  }
}

/** 发送给后端的附件载荷（含提取出的正文 / 引用即驻留元数据）。 */
export interface OutgoingAttachment {
  name: string;
  path: string;
  text: string;
  truncated: boolean;
  kind?: "file" | "dir" | "conversation";
  conversation_id?: string;
  /** 二进制驻留：无 UTF-8 正文。 */
  binary?: boolean;
  /** 客户端已写入工作区时的相对路径（``attachments/…``）。 */
  workspace_path?: string;
}

/** `@Agent` 点名（与 attachments 并列；不扩展 MessageAttachment.kind）。 */
export interface OutgoingAgentMention {
  agent_id: string;
  role: string;
}

export interface StreamConversationOptions {
  conversationId: string;
  content: string;
  attachments?: OutgoingAttachment[];
  agentMentions?: OutgoingAgentMention[];
  /** 必填分流（缺 → 服务端 422）。空闲开跑客户端仍带 ``steer``。 */
  delivery: "steer" | "queue";
  signal?: AbortSignal;
}

/** Send a user message and consume the SSE response stream (发送即有流).
 *
 * In-flight 时流上先到 ``turn_queued``（EPHEMERAL，dispatch 侧呈现「已排队」），
 * drain 后同连接续流整回合；`delivery=steer` 插话为 `user_interjection` 短确认流。 */
export async function streamConversation({
  conversationId,
  content,
  attachments,
  agentMentions,
  delivery,
  signal,
}: StreamConversationOptions): Promise<void> {
  const payload: Record<string, unknown> = { content, delivery };
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  if (agentMentions && agentMentions.length > 0) {
    payload.agent_mentions = agentMentions;
  }
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
  /** team_preview（delegate）continue 修正；缺省 / 空 = 全员开工。 */
  excluded_run_ids?: string[];
  write_capability_overrides?: Array<{
    run_id: string;
    capability: "text_only";
  }>;
  /** 人盖 CEO 的 per-run 模型；空/缺 = 不改。 */
  model_overrides?: Record<
    string,
    { model: string; origin?: "platform" | "byok"; provider_id?: string }
  >;
  /** Structured website style pick (s0/s1/…). */
  signal?: AbortSignal;
}

export async function resumeConversation({
  conversationId,
  messageId,
  decision,
  note,
  selected = [],
  excluded_run_ids,
  write_capability_overrides,
  model_overrides,
  signal,
}: ResumeConversationOptions): Promise<void> {
  const body = JSON.stringify({
    decision,
    note,
    selected,
    ...(excluded_run_ids && excluded_run_ids.length > 0
      ? { excluded_run_ids }
      : {}),
    ...(write_capability_overrides && write_capability_overrides.length > 0
      ? { write_capability_overrides }
      : {}),
    ...(model_overrides && Object.keys(model_overrides).length > 0
      ? { model_overrides }
      : {}),
  });
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages/${messageId}/resume`,
    body,
    conversationId,
    signal,
  );
}

export interface ResolveStageCardOptions {
  conversationId: string;
  stageCardId: string;
  decision: "start_debate" | "research_first";
  note?: string;
  motionOverride?: string | null;
  signal?: AbortSignal;
}

/** 批 B：推进卡 resolve → SSE 新回合（机制直起辩论或回灌调研）。 */
export async function resolveStageCardConversation({
  conversationId,
  stageCardId,
  decision,
  note = "",
  motionOverride = null,
  signal,
}: ResolveStageCardOptions): Promise<void> {
  const body = JSON.stringify({
    kind: "stage_card",
    decision,
    note,
    motion_override: motionOverride,
  });
  await runMessageStream(
    `/v1/conversations/${conversationId}/interactions/${stageCardId}`,
    body,
    conversationId,
    signal,
  );
}

// Re-export SSE dispatch surface (shared by cloud + sidecar paths).
export {
  dispatchSSEEvent,
  flushPendingContent,
  flushPendingFrames,
} from "./sse/dispatch";
