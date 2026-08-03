import { loadLatestWindow } from "@/services/messages";

/**
 * Soft-reload the latest message window so journal `runs` (and harvest copy)
 * catch up with a background coordination drive.
 *
 * Used after:
 * - `execution_completed` — harvest 终稿 / 合成用户消息
 * - `execution_detached` — captain 已收口、工人仍跑；live 若丢 `run_completed`，
 *   InlineTeamGraph 靠更新后的 `message.runs` + hydrate 终态优先自愈翻绿
 *
 * `execution_completed` 可早于 harvest 落库；同连接内 terminal phase 会挡住
 * attach，故用短延迟重试覆盖收口回合写完窗口（离开再回来仍走 ConversationPage
 * 正常加载）。
 */
export function refreshAfterBackgroundExecution(conversationId: string): void {
  const reload = (): void => {
    void loadLatestWindow(conversationId).catch(() => {
      /* best-effort */
    });
  };
  reload();
  const schedule =
    typeof globalThis.setTimeout === "function"
      ? globalThis.setTimeout.bind(globalThis)
      : null;
  if (schedule) {
    schedule(reload, 1500);
    schedule(reload, 6000);
  }
}

/** @deprecated Prefer {@link refreshAfterBackgroundExecution}; kept as alias. */
export function refreshAfterExecutionCompleted(conversationId: string): void {
  refreshAfterBackgroundExecution(conversationId);
}
