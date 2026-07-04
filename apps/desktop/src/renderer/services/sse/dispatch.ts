import { captureSSEEvent } from "@/preview/recorder";
import { traceSSEEvent } from "@/services/sseTrace";
import { traceTurnFirstSSE } from "@/services/turnTrace";
import type { SSEEvent } from "@/types/events";
import { handleBoardEvent } from "./handlers/board";
import { handleExecutionEvent } from "./handlers/execution";
import { handleInteractionEvent } from "./handlers/interaction";
import { handleMessageStreamEvent } from "./handlers/messageStream";
import { handleMetaEvent } from "./handlers/meta";
import { handleWorkspaceEvent } from "./handlers/workspace";
import type { DispatchContext } from "./types";

const HANDLERS = [
  handleMessageStreamEvent,
  handleInteractionEvent,
  handleMetaEvent,
  handleWorkspaceEvent,
  handleBoardEvent,
  handleExecutionEvent,
] as const;

/**
 * Single source of truth for SSE event handling.
 *
 * Conversation-level events feed the chat store (single-agent path).
 * `run_*` and tool events feed the execution store — they no-op while no
 * execution exists, so the multi-agent UI lights up automatically once the
 * backend starts emitting them, with zero further frontend wiring.
 */
export function dispatchSSEEvent(event: SSEEvent, ctx: DispatchContext): void {
  // Dev-only 时序探针（默认关；DevTools 执行 __sseTrace() 开）：记每个事件的到达顺序，
  // 回合末把到达序与气泡 process[] 并排对账。no-op when disabled / in prod.
  traceTurnFirstSSE(ctx.conversationId, event.type);
  traceSSEEvent(event, ctx.conversationId);

  // Dev preview recorder tap (no-op unless armed for this exact conversation):
  // buffers a real turn so it can be saved as an offline preview recording. Armed
  // only via the DEV-gated record button, so production never records.
  captureSSEEvent(event, ctx.conversationId);

  for (const handler of HANDLERS) {
    if (handler(event, ctx)) return;
  }
}

export type { DispatchContext } from "./types";
export {
  discardPendingContent,
  flushPendingContent,
} from "./contentBuffer";
export { discardPendingFrames, flushPendingFrames } from "./execFrameBuffer";
