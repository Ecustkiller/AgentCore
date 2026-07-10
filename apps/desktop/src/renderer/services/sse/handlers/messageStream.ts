import { surfaceResumeFromLiveTurn } from "@/services/resume";
import { traceTurnEnd } from "@/services/sseTrace";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { execRuntime, useExecutionStore } from "@/stores/execution";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import type {
  ContentDeltaPayload,
  ErrorPayload,
  MessageEndPayload,
  MessageStartPayload,
  ReasoningDeltaPayload,
  SSEEvent,
  ToolProgressPayload,
  TurnWarningPayload,
} from "@/types/events";
import { resetCaptainContext } from "../captainContext";
import {
  discardPendingContent,
  ensureStreamingAssistant,
  flushPendingContent,
  queueContentDelta,
  queueReasoningDelta,
} from "../contentBuffer";
import { flushPendingFrames } from "../execFrameBuffer";
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
    case "turn_warning": {
      const payload = event.payload as TurnWarningPayload;
      useConversationStore
        .getState()
        .recordTurnWarning(payload.message, conversationId);
      return true;
    }
    case "message_start": {
      const payload = event.payload as MessageStartPayload;
      // Resume = same-turn continuation: if an assistant already matches the
      // server message_id, reuse it (idempotent). Never delete+create.
      const store = useConversationStore.getState();
      const existing = payload.message_id
        ? getRuntime(conversationId).messages.find(
            (m) =>
              m.role === "assistant" &&
              (m.id === payload.message_id ||
                m.serverMessageId === payload.message_id),
          )
        : undefined;
      if (existing) {
        if (!existing.isStreaming) {
          store.resumePausedAssistant(payload.message_id, conversationId);
        } else {
          store.setGenerating(true, conversationId);
        }
      } else {
        ensureStreamingAssistant(conversationId);
        store.setGenerating(true, conversationId);
      }
      store.stampPendingTurnWarning(conversationId);
      if (payload.trace_id)
        store.setTraceIdOnLastMessage(payload.trace_id, conversationId);
      // Stamp server turn id (and one-time align execution client→server).
      store.setServerMessageIdOnLastMessage(payload.message_id, conversationId);
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
      // rAF 合批思考流 (流式性能): 与正文共用一条 rAF、同点 flush，避免逐 token 写 store。
      queueReasoningDelta(
        conversationId,
        (event.payload as ReasoningDeltaPayload).delta,
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
      // Land any rAF-buffered worker frames before the turn finalizes so the graph's
      // last deltas aren't dropped on a fast end (流式性能合批的收尾兜底).
      flushPendingFrames(conversationId);
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
          collab: payload.collab,
        },
        conversationId,
      );
      conv.finalizeLastMessage(conversationId);
      clearInteractionPrompts(conversationId);
      // 挂起即收口 (②): a turn can END at a durable checkpoint — message_end carries
      // finish_reason=paused. The turn is NOT done: its frame was persisted and its
      // in-process resolve Future was never parked, so keep the graph paused (not
      // "completed") and let the now-dormant inline checkpoint card hand off to the
      // (single) durable resume card, surfaced from the *_required payload already on the
      // bubble (no /recovery round-trip → reproduces offline in #/preview).
      const paused = payload.finish_reason === "paused";
      const mid = execMessageId(conversationId);
      if (mid) {
        const rt = execRuntime(useExecutionStore.getState(), mid);
        if (rt.plan && rt.status !== "failed") {
          useExecutionStore
            .getState()
            .setStatus(paused ? "paused" : "completed", mid);
        }
      }
      conv.releaseBackgroundSlice(conversationId);
      finalizeTurnTrace(conversationId);
      if (paused) surfaceResumeFromLiveTurn(conversationId, ctx.source);
      return true;
    }
    case "error": {
      flushPendingContent(conversationId);
      flushPendingFrames(conversationId);
      ensureStreamingAssistant(conversationId);
      const store = useConversationStore.getState();
      const payload = event.payload as ErrorPayload;
      store.attachErrorToLastMessage(
        {
          code: payload.code,
          message: payload.message,
          context: payload.context,
        },
        conversationId,
      );
      store.finalizeLastMessage(conversationId);
      clearInteractionPrompts(conversationId);
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
