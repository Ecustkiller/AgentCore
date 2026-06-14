import { notifyUnauthorized, tryRefresh } from "@/services/api";
import { useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import type {
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  CheckpointReviewPayload,
  ContentDeltaPayload,
  ErrorPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  ReasoningDeltaPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunOutputDeltaPayload,
  RunPlanPayload,
  RunProgressPayload,
  RunStartedPayload,
  SSEEvent,
  TitleGeneratedPayload,
  ToolUseEndPayload,
  ToolUseStartPayload,
  TurnSavedPayload,
} from "@/types/events";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

interface DispatchContext {
  conversationId: string;
}

export type StreamErrorKind = "network" | "http" | "auth";

/** A transport-level failure of the SSE turn (distinct from a backend `error`
 * event, which is delivered inline). Carries a kind so the UI can phrase it. */
export class StreamError extends Error {
  constructor(
    public kind: StreamErrorKind,
    public status?: number,
  ) {
    super(`stream ${kind}${status ? ` ${status}` : ""}`);
    this.name = "StreamError";
  }
}

/** A user-facing zh message for a failed turn, or null when no banner should
 * show (auth failures already redirect to the login screen). */
export function describeStreamError(err: unknown): string | null {
  if (err instanceof StreamError) {
    if (err.kind === "auth") return null;
    if (err.kind === "http") {
      return `服务暂时不可用（${err.status ?? "?"}），请重试`;
    }
    return "网络连接中断，请检查网络后重试";
  }
  return "发送失败，请重试";
}

/** Wall-clock time of an event, used to label timeline frames. */
function frameTime(event: SSEEvent): number {
  const parsed = Date.parse(event.timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Ensure the last message is a streaming assistant message.
 *
 * Backend always emits `message_start` before content, but this stays
 * defensive so a stray `content_delta` never lands on the user bubble.
 */
function ensureStreamingAssistant(): void {
  const store = useConversationStore.getState();
  const last = store.messages[store.messages.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) {
    store.createAssistantMessage();
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
  switch (event.type) {
    // ---- single-agent conversation stream ----
    case "message_start": {
      ensureStreamingAssistant();
      useConversationStore.getState().setGenerating(true);
      break;
    }
    case "content_delta": {
      ensureStreamingAssistant();
      useConversationStore
        .getState()
        .appendToLastMessage((event.payload as ContentDeltaPayload).delta);
      break;
    }
    case "reasoning_delta": {
      ensureStreamingAssistant();
      useConversationStore
        .getState()
        .appendReasoningToLastMessage(
          (event.payload as ReasoningDeltaPayload).delta,
        );
      break;
    }
    case "message_end": {
      useConversationStore.getState().finalizeLastMessage();
      const exec = useExecutionStore.getState();
      if (exec.plan && exec.status !== "failed") {
        exec.setStatus("completed");
      }
      exec.clearPendingCheckpoint();
      exec.clearPendingReview();
      break;
    }
    case "error": {
      ensureStreamingAssistant();
      const store = useConversationStore.getState();
      store.appendToLastMessage(
        `\n\n**Error**: ${(event.payload as ErrorPayload).message}`,
      );
      store.finalizeLastMessage();
      const exec = useExecutionStore.getState();
      if (exec.plan) exec.setStatus("failed");
      break;
    }
    case "title_generated": {
      useConversationStore
        .getState()
        .renameConversation(
          ctx.conversationId,
          (event.payload as TitleGeneratedPayload).title,
        );
      break;
    }
    case "turn_saved": {
      const payload = event.payload as TurnSavedPayload;
      useConversationStore.getState().reconcileLastTurn(payload.user_message_id);
      break;
    }

    // ---- multi-agent execution stream ----
    // Each run/tool fact is appended to the journal; the graph is a projection
    // of that frame stream (see stores/execution.ts), so live + replay share
    // one fold and there is no per-event UI wiring beyond recording the fact.
    case "run_plan": {
      const payload = event.payload as RunPlanPayload;
      useExecutionStore.getState().startExecution({
        id: payload.execution_id,
        planType: payload.plan_type,
        taskSummary: payload.task_summary,
        agents: payload.agents.map((a) => ({
          id: a.id,
          role: a.role,
          modelPreference: a.model_preference,
          thinking: a.thinking,
          reasoningEffort: a.reasoning_effort,
        })),
        steps: payload.steps.map((s) => ({
          id: s.id,
          agentId: s.agent_id,
          task: s.task,
          dependsOn: s.depends_on,
        })),
      });
      break;
    }
    case "plan_review_required": {
      const payload = event.payload as PlanReviewRequiredPayload;
      const exec = useExecutionStore.getState();
      exec.setPendingReview({ reviewId: payload.review_id });
      exec.setStatus("paused");
      break;
    }
    case "plan_review_resolved": {
      const payload = event.payload as PlanReviewResolvedPayload;
      const exec = useExecutionStore.getState();
      if (payload.action === "cancel") {
        // Nothing ran: drop the whole execution so no idle team card lingers
        // (the "已取消执行。" content_delta becomes the assistant reply).
        exec.clearExecution();
      } else {
        exec.clearPendingReview();
        if (exec.plan) exec.setStatus("running");
      }
      break;
    }
    case "run_started": {
      const payload = event.payload as RunStartedPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "run_started",
        agentId: payload.agent_id,
        stepId: payload.step_id,
      });
      break;
    }
    case "run_output_delta": {
      const payload = event.payload as RunOutputDeltaPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "run_output_delta",
        agentId: payload.agent_id,
        delta: payload.delta,
      });
      break;
    }
    case "run_completed": {
      const payload = event.payload as RunCompletedPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "run_completed",
        stepId: payload.run_id,
        agentId: payload.agent_id,
        outputSummary: payload.output_summary,
        durationMs: payload.duration_ms,
      });
      break;
    }
    case "run_failed": {
      const payload = event.payload as RunFailedPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "run_failed",
        stepId: payload.run_id,
        agentId: payload.agent_id,
        error: payload.error,
      });
      break;
    }
    case "run_progress": {
      const payload = event.payload as RunProgressPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "run_progress",
        completed: payload.completed,
        total: payload.total,
      });
      break;
    }
    case "checkpoint_review": {
      const payload = event.payload as CheckpointReviewPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "checkpoint_review",
        checkpointId: payload.checkpoint_id,
        stepId: payload.after_step,
        decision: payload.decision,
        reason: payload.reason,
        summary: payload.summary,
      });
      break;
    }
    case "approval_required": {
      const payload = event.payload as ApprovalRequiredPayload;
      const exec = useExecutionStore.getState();
      exec.setPendingCheckpoint({
        checkpointId: payload.checkpoint_id,
        afterStep: payload.after_step,
        summary: payload.summary,
        reason: payload.reason,
        actions: payload.actions,
      });
      exec.setStatus("paused");
      break;
    }
    case "approval_resolved": {
      const payload = event.payload as ApprovalResolvedPayload;
      const exec = useExecutionStore.getState();
      exec.recordFrame({
        t: frameTime(event),
        kind: "checkpoint_resolved",
        checkpointId: payload.checkpoint_id,
        action: payload.action,
      });
      exec.clearPendingCheckpoint();
      if (exec.plan) exec.setStatus("running");
      break;
    }
    case "tool_use_start": {
      const payload = event.payload as ToolUseStartPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "tool_use_start",
        toolCallId: payload.tool_call_id,
        toolName: payload.tool_name,
        arguments: payload.arguments,
      });
      break;
    }
    case "tool_use_end": {
      const payload = event.payload as ToolUseEndPayload;
      useExecutionStore.getState().recordFrame({
        t: frameTime(event),
        kind: "tool_use_end",
        toolCallId: payload.tool_call_id,
        result: payload.result,
        status: payload.status,
      });
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
  // Each turn is replanned: drop any prior execution graph / checkpoint so the
  // UI reflects only the current turn (run_plan repopulates for multi-agent).
  useExecutionStore.getState().clearExecution();

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
      throw new StreamError("http", response.status);
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
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
