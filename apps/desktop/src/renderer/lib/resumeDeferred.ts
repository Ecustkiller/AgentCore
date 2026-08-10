/** Cold resume × live slot busy — EPHEMERAL `resume_deferred` (三模型 · deferred). */

export type ResumeDeferredBusyReason = "wrap_up" | "live_turn";

export interface ResumeDeferredPayload {
  message_id: string;
  conversation_id: string;
  busy_reason: ResumeDeferredBusyReason;
}

export function isResumeDeferredBusyReason(
  value: unknown,
): value is ResumeDeferredBusyReason {
  return value === "wrap_up" || value === "live_turn";
}

/** Card-face copy after settlement is locked; wrap_up vs live_turn differ slightly. */
export function resumeDeferredCardCopy(
  busyReason: ResumeDeferredBusyReason,
): string {
  if (busyReason === "wrap_up") {
    return "放行已记下，收尾完成后自动继续；可点停止加速卸锁";
  }
  return "放行已记下，当前回合结束后自动继续；可点停止加速卸锁";
}

export function parseResumeDeferredPayload(
  payload: unknown,
): ResumeDeferredPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const messageId = p.message_id;
  const conversationId = p.conversation_id;
  const busyReason = p.busy_reason;
  if (typeof messageId !== "string" || !messageId) return null;
  if (typeof conversationId !== "string" || !conversationId) return null;
  if (!isResumeDeferredBusyReason(busyReason)) return null;
  return {
    message_id: messageId,
    conversation_id: conversationId,
    busy_reason: busyReason,
  };
}
