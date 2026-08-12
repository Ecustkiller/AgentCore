import type { SSEEvent } from "@/types/events";
import type { DispatchContext } from "../types";

/**
 * Board CLIENT_TOOL frames (`board_op_required` / `board_read_required`) ride the
 * device fulfill stream for cloud turns; sidecar delivery is handled in
 * `dispatchSSEEvent`. This handler is a no-op stub.
 */
export function handleBoardEvent(
  _event: SSEEvent,
  _ctx: DispatchContext,
): boolean {
  return false;
}
