import { logEvent } from "@/lib/log";

let installed = false;

/**
 * App 生命周期订阅一次 ``queue/needStart``。
 * 开跑在渲染进程：先认领事件，再 startTurn。
 */
export function installQueuedSidecarTurnListener(): void {
  if (installed) return;
  if (typeof window === "undefined" || !window.sidecarApi?.onQueueNeedStart) {
    return;
  }
  installed = true;
  window.sidecarApi.onQueueNeedStart((notice) => {
    void import("@/services/streamConversationViaSidecar")
      .then(({ startQueuedSidecarTurn }) => startQueuedSidecarTurn(notice))
      .catch((err: unknown) => {
        logEvent("error", "sidecar.queue_need_start_failed", {
          conversation_id: notice.conversationId,
          queue_id: notice.queueId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
}

/** 测试隔离。 */
export function resetQueuedSidecarTurnListenerForTests(): void {
  installed = false;
}
