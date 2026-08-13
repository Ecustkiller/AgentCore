import type { ResumeOrigin } from "@/stores/pausedTurns";

/** Per-turn dispatch context passed to every SSE handler. */
export interface DispatchContext {
  conversationId: string;
  /** Which transport delivered this event — set at the dispatch entry (HTTP SSE vs sidecar IPC). */
  source: ResumeOrigin;
  /**
   * 这一帧来自 catch-up 重放段（journal 回放），不是刚发生的转折。
   *
   * 重放段可能把整个 live run 从头再折一遍，所以任何「刚刚变了」的呈现（如卡被另一端拍板
   * 的收口条）都必须认这个标记，否则每次重连都会重播一遍旧转折。只在 ``foldAttachSegment``
   * 这个唯一的重放漏斗设置。
   */
  replay?: boolean;
}
