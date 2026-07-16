import { notifyError, notifyInfo } from "@/lib/toast";
import { ApiError, api } from "@/services/api";
import type { OutgoingAttachment } from "@/services/streamConversation";

export type MidFlightSendResult =
  | { kind: "delivered"; interjectionId: string }
  | { kind: "queued"; position: number; queueDepth: number }
  | { kind: "blocked"; code?: string }
  | { kind: "error" };

/**
 * POST a user message while a turn is already streaming.
 * Coordination → 202 delivered (SSE `user_interjection` on the live sink);
 * classic → 202 queued; hot pending → 409.
 * Attachments reuse the same OutgoingAttachment shape as a normal send.
 */
export async function sendMidFlightMessage(
  conversationId: string,
  content: string,
  attachments?: OutgoingAttachment[],
): Promise<MidFlightSendResult> {
  try {
    const body: Record<string, unknown> = { content };
    if (attachments && attachments.length > 0) body.attachments = attachments;

    const res = await api.post<{
      status?: string;
      interjection_id?: string;
      queue_id?: string;
      position?: number;
      queue_depth?: number;
    }>(`/v1/conversations/${conversationId}/messages`, body);

    if (res.status === "delivered" && res.interjection_id) {
      return { kind: "delivered", interjectionId: res.interjection_id };
    }
    if (res.status === "queued") {
      return {
        kind: "queued",
        position: res.position ?? 1,
        queueDepth: res.queue_depth ?? 1,
      };
    }
    // Unexpected 2xx shape — treat as queued for UX safety.
    return { kind: "queued", position: 1, queueDepth: 1 };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      notifyError(err, "请先处理待确认事项");
      return { kind: "blocked", code: err.code };
    }
    notifyError(err, "发送失败");
    return { kind: "error" };
  }
}

export function notifyMidFlightResult(result: MidFlightSendResult): void {
  if (result.kind === "queued") {
    notifyInfo(
      result.queueDepth > 1
        ? `已排队（第 ${result.position}/${result.queueDepth} 条），当前回合结束后处理`
        : "已排队，当前回合结束后处理",
    );
  }
  // delivered: badge appears in team block via SSE — no toast needed.
}
