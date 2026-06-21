import { getRuntime, useConversationStore } from "@/stores/conversation";

/**
 * Ensure the streamed conversation's last message is a streaming assistant
 * message.
 *
 * Backend always emits `message_start` before content, but this stays
 * defensive so a stray `content_delta` never lands on the user bubble. Targets
 * the turn's conversation by id so a background turn opens its bubble on its own
 * slice, not whatever conversation is on screen.
 */
export function ensureStreamingAssistant(conversationId: string): void {
  const messages = getRuntime(conversationId).messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) {
    useConversationStore.getState().createAssistantMessage(conversationId);
  }
}

/**
 * rAF 合批 content_delta（流式渲染性能）。
 *
 * 后端逐 token 推 content_delta，每个都直接写 store 会让 Markdown 每 token 全量重渲染
 * （叠加块级记忆化前尤甚）。这里把同一会话「一帧内」的 delta 攒成一批，在下一次
 * animation frame 一次性 append——把每秒上百次 store 写入降到 ≤60 次。按 conversationId
 * 分桶，故多个后台会话各自合批、互不串台。
 *
 * 必须在回合收尾前 flush：`appendToLastMessage` / `finalizeLastMessage` 都不校验
 * `isStreaming`，缓冲若漏到收尾之后，rAF 回调会把尾 token 追加到已结束（极端情况下是下一条）
 * 的消息上。故 `message_end` / `error` 分支会先 flush，传输层 finally 再兜底 flush。
 */
const pendingContent = new Map<string, string>();
const pendingFrame = new Map<string, number>();

/** 立即写出某会话已缓冲的 content，并取消其挂起的 frame。无缓冲时为 no-op。 */
export function flushPendingContent(conversationId: string): void {
  const frame = pendingFrame.get(conversationId);
  if (frame !== undefined) {
    cancelAnimationFrame(frame);
    pendingFrame.delete(conversationId);
  }
  const buffered = pendingContent.get(conversationId);
  if (buffered === undefined) return;
  pendingContent.delete(conversationId);
  useConversationStore.getState().appendToLastMessage(buffered, conversationId);
}

/** 丢弃某会话已缓冲但未写出的 content（取消挂起 frame，且不 append）。`content_reset` 用：
 * 那批 delta 属于被交付前核验否决的违规正文，无需落到气泡。无缓冲时仅取消挂起 frame。 */
export function discardPendingContent(conversationId: string): void {
  const frame = pendingFrame.get(conversationId);
  if (frame !== undefined) {
    cancelAnimationFrame(frame);
    pendingFrame.delete(conversationId);
  }
  pendingContent.delete(conversationId);
}

/** 把一段 content delta 入桶，并确保已排定一次 frame flush。 */
export function queueContentDelta(conversationId: string, delta: string): void {
  pendingContent.set(
    conversationId,
    (pendingContent.get(conversationId) ?? "") + delta,
  );
  if (pendingFrame.has(conversationId)) return;
  const frame = requestAnimationFrame(() => {
    pendingFrame.delete(conversationId);
    flushPendingContent(conversationId);
  });
  pendingFrame.set(conversationId, frame);
}
