import { patchConversationCache } from "@/hooks/useConversations";
import { StreamError } from "@/lib/errors";
import { notifyUnauthorized, tryRefresh } from "@/services/api";
import { performWorkspaceOp } from "@/services/workspaceOps";
import { useApprovalStore } from "@/stores/approvals";
import {
  getRuntime,
  lastAssistantMessageId,
  useConversationStore,
} from "@/stores/conversation";
import {
  execRuntime,
  frameFromEvent,
  planFromRunPlan,
  useExecutionStore,
} from "@/stores/execution";
import type {
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  CitationsPayload,
  ContentDeltaPayload,
  ErrorPayload,
  MessageEndPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  ReasoningDeltaPayload,
  RunPlanPayload,
  SSEEvent,
  TitleGeneratedPayload,
  TurnSavedPayload,
  WorkspaceOpRequiredPayload,
} from "@/types/events";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

interface DispatchContext {
  conversationId: string;
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
 * Ensure the streamed conversation's last message is a streaming assistant
 * message.
 *
 * Backend always emits `message_start` before content, but this stays
 * defensive so a stray `content_delta` never lands on the user bubble. Targets
 * the turn's conversation by id so a background turn opens its bubble on its own
 * slice, not whatever conversation is on screen.
 */
function ensureStreamingAssistant(conversationId: string): void {
  const messages = getRuntime(conversationId).messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) {
    useConversationStore.getState().createAssistantMessage(conversationId);
  }
}

/**
 * Single source of truth for SSE event handling.
 *
 * Conversation-level events feed the chat store (single-agent path).
 * `run_*` and tool events feed the execution store — they no-op while no
 * execution exists, so the multi-agent UI lights up automatically once the
 * backend starts emitting them, with zero further frontend wiring.
 */
export function dispatchSSEEvent(event: SSEEvent, ctx: DispatchContext): void {
  // The execution store keys each turn's graph by the assistant message it
  // produced (§9.3). Every run/tool fact of a turn belongs to the bubble opened
  // by `message_start`, so resolve that id from the conversation's live slice
  // and route execution mutations to it (live + replay then share one slot).
  const execMessageId = (): string | null =>
    lastAssistantMessageId(getRuntime(ctx.conversationId).messages);

  switch (event.type) {
    // ---- single-agent conversation stream ----
    case "message_start": {
      ensureStreamingAssistant(ctx.conversationId);
      useConversationStore.getState().setGenerating(true, ctx.conversationId);
      break;
    }
    case "content_delta": {
      ensureStreamingAssistant(ctx.conversationId);
      useConversationStore
        .getState()
        .appendToLastMessage(
          (event.payload as ContentDeltaPayload).delta,
          ctx.conversationId,
        );
      break;
    }
    case "reasoning_delta": {
      ensureStreamingAssistant(ctx.conversationId);
      useConversationStore
        .getState()
        .appendReasoningToLastMessage(
          (event.payload as ReasoningDeltaPayload).delta,
          ctx.conversationId,
        );
      break;
    }
    case "message_end": {
      const payload = event.payload as MessageEndPayload;
      const conv = useConversationStore.getState();
      // Stamp the turn total (回合总账) onto the assistant bubble before
      // finalizing, so the per-turn cost row (§7.3A) renders from state; null on
      // the error / not-found paths where no turn ran.
      if (payload.cost) {
        conv.attachCostToLastMessage(payload.cost, ctx.conversationId);
      }
      conv.finalizeLastMessage(ctx.conversationId);
      // The turn is over — any approval still on screen is moot (all were
      // resolved to get here; this just guards a degraded/edge end).
      useApprovalStore.getState().clear(ctx.conversationId);
      // Settle this turn's graph (keyed by its assistant message) to its final
      // state; resolve the id before releasing the slice below.
      const mid = execMessageId();
      if (mid) {
        const rt = execRuntime(useExecutionStore.getState(), mid);
        if (rt.plan && rt.status !== "failed") {
          useExecutionStore.getState().setStatus("completed", mid);
        }
      }
      // A turn that finished while the user is on another conversation leaves an
      // idle background slice that no switch will reclaim; release it now so the
      // memory bound holds (no-op for the active conversation — it reloads from
      // the server on return).
      conv.releaseBackgroundSlice(ctx.conversationId);
      break;
    }
    case "error": {
      ensureStreamingAssistant(ctx.conversationId);
      const store = useConversationStore.getState();
      const payload = event.payload as ErrorPayload;
      // Attach a structured error to the bubble (rendered as a friendly inline
      // card) rather than splicing a raw `**Error**:` line into the answer text.
      store.attachErrorToLastMessage(
        { code: payload.code, message: payload.message },
        ctx.conversationId,
      );
      store.finalizeLastMessage(ctx.conversationId);
      useApprovalStore.getState().clear(ctx.conversationId);
      const mid = execMessageId();
      if (mid && execRuntime(useExecutionStore.getState(), mid).plan) {
        useExecutionStore.getState().setStatus("failed", mid);
      }
      // Failed turn in the background → same idle-slice reclaim as message_end
      // (a transport failure instead routes through turns.ts, which keeps the
      // slice so its retry banner survives).
      store.releaseBackgroundSlice(ctx.conversationId);
      break;
    }

    // ---- tool approval gate (CEO chat path) ----
    // A GRANTABLE tool call is paused awaiting the user's decision; the inline
    // prompt (rendered above the composer) settles it via the resolve endpoint.
    case "approval_required": {
      useApprovalStore.getState().add(event.payload as ApprovalRequiredPayload);
      break;
    }
    case "approval_resolved": {
      useApprovalStore
        .getState()
        .remove((event.payload as ApprovalResolvedPayload).approval_id);
      break;
    }
    case "checkpoint_required": {
      // Unlike approvals (a transient store), a checkpoint lives on its assistant
      // message so it replays inline; attach a pending card to the live bubble.
      useConversationStore
        .getState()
        .addCheckpoint(
          event.payload as CheckpointRequiredPayload,
          ctx.conversationId,
        );
      break;
    }
    case "checkpoint_resolved": {
      const p = event.payload as CheckpointResolvedPayload;
      useConversationStore
        .getState()
        .settleCheckpoint(
          p.checkpoint_id,
          p.decision,
          p.note ?? "",
          p.selected ?? [],
          ctx.conversationId,
        );
      break;
    }
    case "plan_review_required": {
      // Like an ask_user checkpoint (and unlike a transient approval), a
      // plan_review lives on its assistant message so it replays inline; attach a
      // pending card to the live bubble. Also fold it into the team graph as a
      // frame so the gated node shows a pause badge (结构化挂起 2a, 7.2A).
      useConversationStore
        .getState()
        .addPlanReview(
          event.payload as PlanReviewRequiredPayload,
          ctx.conversationId,
        );
      {
        const mid = execMessageId();
        const frame = frameFromEvent(event);
        if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      }
      break;
    }
    case "plan_review_resolved": {
      const p = event.payload as PlanReviewResolvedPayload;
      useConversationStore
        .getState()
        .settlePlanReview(
          p.checkpoint_id,
          p.decision,
          p.note ?? "",
          ctx.conversationId,
        );
      {
        const mid = execMessageId();
        const frame = frameFromEvent(event);
        if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      }
      break;
    }
    case "title_generated": {
      patchConversationCache(ctx.conversationId, {
        title: (event.payload as TitleGeneratedPayload).title,
      });
      break;
    }
    case "turn_saved": {
      const payload = event.payload as TurnSavedPayload;
      useConversationStore
        .getState()
        .reconcileLastTurn(payload.user_message_id, ctx.conversationId);
      break;
    }
    case "citations": {
      const payload = event.payload as CitationsPayload;
      useConversationStore
        .getState()
        .attachCitationsToLastMessage(payload.citations, ctx.conversationId);
      break;
    }

    // ---- local-workspace op channel (双模式工作区 P2) ----
    // In local mode the server-side LocalWorkspace asks us to run a file op
    // against the bound FS root; perform it and POST the result back (fire and
    // forget — it settles the paused op in this same SSE turn). No-op in cloud
    // mode, where this event never arrives.
    case "workspace_op_required": {
      void performWorkspaceOp(
        event.payload as WorkspaceOpRequiredPayload,
        ctx.conversationId,
      );
      break;
    }

    // ---- multi-agent execution stream ----
    // Each run/tool fact is appended to the journal; the graph is a projection
    // of that frame stream (see stores/execution.ts), so live + replay share
    // one fold and there is no per-event UI wiring beyond recording the fact.
    case "run_plan": {
      const payload = event.payload as RunPlanPayload;
      const mid = execMessageId();
      if (!mid) break;
      // ingestPlan (not startExecution): a second delegate batch in the same
      // turn shares the execution id and is merged into the live graph instead
      // of resetting it (see stores/execution.ts).
      useExecutionStore.getState().ingestPlan(planFromRunPlan(payload), mid);
      // Mark the assistant turn as team-driven: its bubble renders the inline
      // collaboration graph (统一团队展示草案) and defers the cost row to the
      // graph's status strip (§7.3A). Single-agent turns emit no run_plan, so
      // their bubble keeps `executionId === null` and shows its own ¥ caption.
      // The detail panel is no longer auto-opened — it is a passive drill-down
      // target, opened on demand by clicking a graph node.
      if (payload.plan_type === "multi_agent") {
        useConversationStore
          .getState()
          .setLastAssistantExecutionId(
            payload.execution_id,
            ctx.conversationId,
          );
      }
      break;
    }
    // All run/tool facts fold the same way: map the event to a RunFrame and
    // append it to this turn's journal (a no-op slot has no plan, so stray
    // single-agent facts are ignored downstream). One path for every frame kind.
    case "run_started":
    case "run_output_delta":
    case "run_reasoning_delta":
    case "run_completed":
    case "run_failed":
    case "run_progress":
    case "tool_use_start":
    case "tool_use_end": {
      const mid = execMessageId();
      const frame = frameFromEvent(event);
      if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      break;
    }

    default:
      break;
  }
}

/** 发送给后端的附件载荷（含提取出的正文）。 */
export interface OutgoingAttachment {
  name: string;
  path: string;
  /** 文件为正文；目录为「文件清单」文本。 */
  text: string;
  truncated: boolean;
  /** file=单文件；dir=目录文件清单。 */
  kind?: "file" | "dir";
}

/**
 * POST to an SSE endpoint and route every event through `dispatchSSEEvent`.
 *
 * Shared by send and regenerate: both are a POST returning `text/event-stream`.
 * Uses raw fetch (it must read the streaming body), so it can't ride the `api`
 * 401 interceptor — it mirrors that policy here: on an expired access token,
 * refresh once and replay, else drop to the login screen.
 */
async function runMessageStream(
  path: string,
  body: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  // Each turn streams into its own assistant message's execution slot (keyed by
  // message id, §9.3), so there is no prior graph to clear here — a fresh turn
  // gets a fresh slot on its first run_plan. Just drop any stale approval prompt
  // so the new turn starts from a clean gate.
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

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    // Stall watchdog. The backend sends a heartbeat comment every ~15s while a
    // turn is thinking, so a live connection always keeps delivering bytes. If we
    // receive nothing at all for this long the stream is dead (server/proxy
    // dropped it) — abort and surface a retriable error instead of spinning
    // forever. This is an *idle* timeout, never a total-duration cap: a long turn
    // that keeps streaming (or just heart-beating) is never cut off.
    const IDLE_TIMEOUT_MS = 60_000;
    const readChunk = (): ReturnType<typeof reader.read> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // Free the dead socket so the backend sees the disconnect and stops.
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

    // Stream closed without a terminal event (message_end / inline error) while
    // the turn still reads as generating: settle it so the "正在思考…" bubble and
    // the stop button don't hang forever. No-op on the normal paths, which have
    // already finalized — this only catches a degraded close.
    if (getRuntime(conversationId).isGenerating) {
      useConversationStore.getState().finalizeLastMessage(conversationId);
    }
  } catch (err) {
    // Re-raise user aborts (stop button) and already-typed failures as-is;
    // wrap anything else (fetch reject, reader break) as a network failure.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof StreamError) throw err;
    throw new StreamError("network");
  }
}

export interface StreamConversationOptions {
  conversationId: string;
  content: string;
  attachments?: OutgoingAttachment[];
  signal?: AbortSignal;
}

/**
 * Send a user message and consume the SSE response stream.
 *
 * This is the primary streaming channel for the app.
 */
export async function streamConversation({
  conversationId,
  content,
  attachments,
  signal,
}: StreamConversationOptions): Promise<void> {
  const body = JSON.stringify(
    attachments && attachments.length > 0
      ? { content, attachments }
      : { content },
  );
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages`,
    body,
    conversationId,
    signal,
  );
}

export interface RegenerateConversationOptions {
  conversationId: string;
  /** The user message to re-run from (its later messages are dropped). */
  messageId: string;
  /** When set, edit the user message before re-running (edit & resend). */
  content?: string;
  signal?: AbortSignal;
}

/**
 * Re-run a turn from an existing user message and consume the SSE stream.
 *
 * Backend truncates everything after `messageId` and produces a fresh assistant
 * reply, so the persisted history stays consistent (no duplicate user turns).
 */
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
