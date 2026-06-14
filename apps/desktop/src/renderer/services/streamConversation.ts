import { notifyUnauthorized, tryRefresh } from "@/services/api";
import { useApprovalStore } from "@/stores/approvals";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { execRuntime, useExecutionStore } from "@/stores/execution";
import { useUsageStore } from "@/stores/usage";
import type {
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  CitationsPayload,
  ContentDeltaPayload,
  ErrorPayload,
  MessageEndPayload,
  ReasoningDeltaPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunOutputDeltaPayload,
  RunPlanPayload,
  RunProgressPayload,
  RunReasoningDeltaPayload,
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
        // Fold this turn into the conversation total so the 对话累计 chip (§7.3C)
        // updates live; the turn is persisted too, so a later reload re-seeds the
        // same sum from the ledger. `message_end.usage` uses the legacy *_tokens
        // keys (see MessageEndPayload).
        const u = payload.usage;
        const tokens = u ? u.input_tokens + u.output_tokens : 0;
        useUsageStore
          .getState()
          .addTurnCost(ctx.conversationId, payload.cost.total, tokens);
      }
      conv.finalizeLastMessage(ctx.conversationId);
      // The turn is over — any approval still on screen is moot (all were
      // resolved to get here; this just guards a degraded/edge end).
      useApprovalStore.getState().clear(ctx.conversationId);
      const rt = execRuntime(useExecutionStore.getState(), ctx.conversationId);
      if (rt.plan && rt.status !== "failed") {
        useExecutionStore.getState().setStatus("completed", ctx.conversationId);
      }
      break;
    }
    case "error": {
      ensureStreamingAssistant(ctx.conversationId);
      const store = useConversationStore.getState();
      store.appendToLastMessage(
        `\n\n**Error**: ${(event.payload as ErrorPayload).message}`,
        ctx.conversationId,
      );
      store.finalizeLastMessage(ctx.conversationId);
      useApprovalStore.getState().clear(ctx.conversationId);
      const rt = execRuntime(useExecutionStore.getState(), ctx.conversationId);
      if (rt.plan) {
        useExecutionStore.getState().setStatus("failed", ctx.conversationId);
      }
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

    // ---- multi-agent execution stream ----
    // Each run/tool fact is appended to the journal; the graph is a projection
    // of that frame stream (see stores/execution.ts), so live + replay share
    // one fold and there is no per-event UI wiring beyond recording the fact.
    case "run_plan": {
      const payload = event.payload as RunPlanPayload;
      // ingestPlan (not startExecution): a second delegate batch in the same
      // turn shares the execution id and is merged into the live graph instead
      // of resetting it (see stores/execution.ts).
      useExecutionStore.getState().ingestPlan(
        {
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
          runs: payload.runs.map((s) => ({
            id: s.id,
            agentId: s.agent_id,
            task: s.task,
            dependsOn: s.depends_on,
            kind: s.kind,
          })),
        },
        ctx.conversationId,
      );
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
    case "run_started": {
      const payload = event.payload as RunStartedPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "run_started",
          agentId: payload.agent_id,
          runId: payload.run_id,
          parentRunId: payload.parent_run_id,
          runKind: payload.kind,
        },
        ctx.conversationId,
      );
      break;
    }
    case "run_output_delta": {
      const payload = event.payload as RunOutputDeltaPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "run_output_delta",
          agentId: payload.agent_id,
          delta: payload.delta,
        },
        ctx.conversationId,
      );
      break;
    }
    case "run_reasoning_delta": {
      const payload = event.payload as RunReasoningDeltaPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "run_reasoning_delta",
          agentId: payload.agent_id,
          delta: payload.delta,
        },
        ctx.conversationId,
      );
      break;
    }
    case "run_completed": {
      const payload = event.payload as RunCompletedPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "run_completed",
          runId: payload.run_id,
          agentId: payload.agent_id,
          outputSummary: payload.output_summary,
          durationMs: payload.duration_ms,
          // Carry the priced cost onto the frame so the projected run lights up
          // the team payroll (§7.3B) live, with no separate cost wiring.
          role: payload.role,
          model: payload.model,
          usage: payload.usage,
          cost: payload.cost,
        },
        ctx.conversationId,
      );
      break;
    }
    case "run_failed": {
      const payload = event.payload as RunFailedPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "run_failed",
          runId: payload.run_id,
          agentId: payload.agent_id,
          error: payload.error,
        },
        ctx.conversationId,
      );
      break;
    }
    case "run_progress": {
      const payload = event.payload as RunProgressPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "run_progress",
          completed: payload.completed,
          total: payload.total,
        },
        ctx.conversationId,
      );
      break;
    }
    case "tool_use_start": {
      const payload = event.payload as ToolUseStartPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "tool_use_start",
          toolCallId: payload.tool_call_id,
          toolName: payload.tool_name,
          arguments: payload.arguments,
        },
        ctx.conversationId,
      );
      break;
    }
    case "tool_use_end": {
      const payload = event.payload as ToolUseEndPayload;
      useExecutionStore.getState().recordFrame(
        {
          t: frameTime(event),
          kind: "tool_use_end",
          toolCallId: payload.tool_call_id,
          result: payload.result,
          status: payload.status,
        },
        ctx.conversationId,
      );
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
  // Each turn is replanned: drop this conversation's prior execution graph so
  // the UI reflects only the current turn (run_plan repopulates for
  // multi-agent). Likewise drop any stale approval prompt so a new turn always
  // starts from a clean gate.
  useExecutionStore.getState().clearExecution(conversationId);
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
