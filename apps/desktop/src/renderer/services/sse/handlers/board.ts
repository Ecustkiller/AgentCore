import { performBoardOp } from "@/services/boardOps";
import type { BoardOpRequiredPayload, SSEEvent } from "@/types/events";
import type { DispatchContext } from "../types";

/** AI 协作白板 (AI协作白板.md §六 M2): the server asks the open canvas to apply a board-op
 * batch; we run it against the registered applier and settle the paused op so the turn
 * resumes (fire-and-forget — `performBoardOp` always answers, even on a closed canvas). */
export function handleBoardEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  if (event.type === "board_op_required") {
    void performBoardOp(
      event.payload as BoardOpRequiredPayload,
      ctx.conversationId,
    );
    return true;
  }
  return false;
}
