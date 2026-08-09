import { assertNever } from "@/lib/assertNever";
import { logEvent } from "@/lib/log";
import { traceSSEEvent } from "@/services/sseTrace";
import { traceTurnFirstSSE } from "@/services/turnTrace";
import { allowsSseEvent } from "@/stores/conversation/turnPhase";
import { getTurnPhase } from "@/stores/conversation/turnPhaseActions";
import type { SSEEvent } from "@/types/events";
import { handleBoardEvent } from "./handlers/board";
import { handleDesktopEvent } from "./handlers/desktop";
import { handleExecutionEvent } from "./handlers/execution";
import { handleInteractionEvent } from "./handlers/interaction";
import { handleMessageStreamEvent } from "./handlers/messageStream";
import { handleMetaEvent } from "./handlers/meta";
import { handleWorkspaceEvent } from "./handlers/workspace";
import type { DispatchContext } from "./types";

/**
 * sim.* rides a dedicated AgentTown stream — Desktop no longer projects them.
 * Keep a no-op sink so conversation-bus exhaustiveness does not trip on stray sim frames.
 */
function ignoreSimulationEvent(
  event: SSEEvent,
  _ctx: DispatchContext,
): boolean {
  return event.type.startsWith("sim.");
}

const HANDLERS = [
  ignoreSimulationEvent,
  handleMessageStreamEvent,
  handleInteractionEvent,
  handleMetaEvent,
  handleWorkspaceEvent,
  handleBoardEvent,
  handleDesktopEvent,
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
  // 停止生命周期事件门：stopping 仍消费 run_*，挡正文突变；terminal 只放行终态/meta。
  const turnPhase = getTurnPhase(ctx.conversationId);
  if (!allowsSseEvent(turnPhase, event.type)) {
    // 可观测丢点：勿扫用户长文；只记 event_type / phase（钉门闩 vs 传输丢包）。
    const dropFields: Record<string, unknown> = {
      conversation_id: ctx.conversationId,
      event_type: event.type,
      turn_phase: turnPhase,
      reason: "turn_phase_gate",
    };
    // L3：workspace_op 另带 request_id/op，便于对上服务端超时。
    if (event.type === "workspace_op_required") {
      const payload = event.payload as {
        request_id?: string;
        op?: string;
      };
      dropFields.request_id = payload?.request_id;
      dropFields.op = payload?.op;
      logEvent("warn", "workspace_op.dropped", dropFields);
    } else {
      logEvent("warn", "sse.event_dropped", dropFields);
    }
    return;
  }

  // Dev-only 时序探针（默认关；DevTools 执行 __sseTrace() 开）：记每个事件的到达顺序，
  // 回合末把到达序与气泡 process[] 并排对账。no-op when disabled / in prod.
  traceTurnFirstSSE(ctx.conversationId, event.type);
  traceSSEEvent(event, ctx.conversationId);

  for (const handler of HANDLERS) {
    if (handler(event, ctx)) return;
  }
  // Runtime exhaustiveness tripwire — compile-time coverage for fold lives in
  // conformanceFold's discriminated switch; both must be updated for new SSE types.
  assertNever(event as never);
}

export type { DispatchContext } from "./types";
export {
  discardPendingContent,
  flushPendingContent,
} from "./contentBuffer";
export { flushPendingFrames } from "./execFrameBuffer";
