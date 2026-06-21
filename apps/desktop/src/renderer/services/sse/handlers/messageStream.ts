import { traceTurnEnd } from "@/services/sseTrace";
import { useApprovalStore } from "@/stores/approvals";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { execRuntime, useExecutionStore } from "@/stores/execution";
import type {
  ContentDeltaPayload,
  ErrorPayload,
  MessageEndPayload,
  MessageStartPayload,
  ReasoningDeltaPayload,
  SSEEvent,
  ToolProgressPayload,
} from "@/types/events";
import { resetCaptainContext } from "../captainContext";
import {
  discardPendingContent,
  ensureStreamingAssistant,
  flushPendingContent,
  queueContentDelta,
} from "../contentBuffer";
import { execMessageId } from "../helpers";
import type { DispatchContext } from "../types";

function finalizeTurnTrace(conversationId: string): void {
  const msgs = getRuntime(conversationId).messages;
  const lastA = [...msgs].reverse().find((m) => m.role === "assistant");
  traceTurnEnd(conversationId, lastA?.process);
}

export function handleMessageStreamEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  const { conversationId } = ctx;

  switch (event.type) {
    case "message_start": {
      ensureStreamingAssistant(conversationId);
      useConversationStore.getState().setGenerating(true, conversationId);
      // trace_id 关联气泡↔日志: stamp the turn's log correlation id onto the bubble so a
      // dev「复制 trace id」link jumps straight to this turn's logs. Optional on the wire
      // (absent on untraced turns); idempotent on a reconnect replay (re-sent first).
      {
        const traceId = (event.payload as MessageStartPayload).trace_id;
        if (traceId)
          useConversationStore
            .getState()
            .setTraceIdOnLastMessage(traceId, conversationId);
      }
      // Turn (re)start — clear the captain context accumulator so a reconnect replay
      // (which re-sends message_start first) rebuilds it idempotently (上下文传递可视化 通道①+⑤).
      resetCaptainContext(conversationId);
      return true;
    }
    case "content_delta": {
      ensureStreamingAssistant(conversationId);
      queueContentDelta(
        conversationId,
        (event.payload as ContentDeltaPayload).delta,
      );
      return true;
    }
    case "content_reset": {
      discardPendingContent(conversationId);
      useConversationStore.getState().resetStreamingContent(conversationId);
      return true;
    }
    case "reasoning_delta": {
      ensureStreamingAssistant(conversationId);
      flushPendingContent(conversationId);
      useConversationStore
        .getState()
        .appendReasoningToLastMessage(
          (event.payload as ReasoningDeltaPayload).delta,
          conversationId,
        );
      return true;
    }
    case "tool_progress": {
      ensureStreamingAssistant(conversationId);
      const p = event.payload as ToolProgressPayload;
      useConversationStore
        .getState()
        .setComposingTool(
          { toolName: p.tool_name, chars: p.chars },
          conversationId,
        );
      return true;
    }
    case "message_end": {
      flushPendingContent(conversationId);
      const payload = event.payload as MessageEndPayload;
      const conv = useConversationStore.getState();
      if (payload.cost) {
        conv.attachCostToLastMessage(payload.cost, conversationId);
      }
      const usage = payload.usage;
      conv.attachTurnMetaToLastMessage(
        {
          usage: usage
            ? {
                input: usage.input_tokens,
                output: usage.output_tokens,
                reasoning: usage.reasoning_tokens,
                cache_hit: usage.cache_hit_tokens,
                cache_miss: usage.cache_miss_tokens,
              }
            : undefined,
          rounds: payload.rounds,
          finishReason: payload.finish_reason,
        },
        conversationId,
      );
      conv.finalizeLastMessage(conversationId);
      useApprovalStore.getState().clear(conversationId);
      const mid = execMessageId(conversationId);
      if (mid) {
        const rt = execRuntime(useExecutionStore.getState(), mid);
        if (rt.plan && rt.status !== "failed") {
          useExecutionStore.getState().setStatus("completed", mid);
        }
      }
      conv.releaseBackgroundSlice(conversationId);
      finalizeTurnTrace(conversationId);
      return true;
    }
    case "error": {
      flushPendingContent(conversationId);
      ensureStreamingAssistant(conversationId);
      const store = useConversationStore.getState();
      const payload = event.payload as ErrorPayload;
      store.attachErrorToLastMessage(
        { code: payload.code, message: payload.message },
        conversationId,
      );
      store.finalizeLastMessage(conversationId);
      useApprovalStore.getState().clear(conversationId);
      const mid = execMessageId(conversationId);
      if (mid && execRuntime(useExecutionStore.getState(), mid).plan) {
        useExecutionStore.getState().setStatus("failed", mid);
      }
      store.releaseBackgroundSlice(conversationId);
      finalizeTurnTrace(conversationId);
      return true;
    }
    default:
      return false;
  }
}
