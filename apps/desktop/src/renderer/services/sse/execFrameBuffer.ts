import { type RunFrame, useExecutionStore } from "@/stores/execution";
import { execMessageId } from "./helpers";
import {
  cancelCappedFlush,
  noteCappedFlush,
  resetCappedFlush,
  scheduleCappedFlush,
} from "./streamFlushScheduler";

/**
 * 60Hz 合批执行帧（流式渲染性能，content_delta 的团队图对偶）。
 *
 * 后端逐 token 推 `run_output_delta` / `run_reasoning_delta`（多 worker / 辩论时尤密），
 * 每个都直接 `recordFrame` 会：① 全量复制 `frames[]`（O(n)）；② 换新 `ExecutionRuntime`
 * 使投影缓存每 tick 失效 → 全图重折叠；③ 触发所有图/面板消费者重渲染。逐 token 叠加即
 * 整条流 O(n²)，是「长输出白屏卡死」的团队侧根因。这里把同一会话到达的 frame 攒成一批，
 * 按 ≤60Hz 写出（{@link useExecutionStore.recordFrames}；跟屏幕刷新脱钩）。按 conversationId
 * 分桶，多个后台会话各自合批、互不串台。
 *
 * 只应缓冲**高频且纯累积**的帧（output/reasoning delta、tool_progress、output_reset）；
 * 结构性帧（run_started / run_completed / tool_use_* / plan_* / debate_* …）必须先
 * {@link flushPendingFrames} 再立即落，以保「帧顺序」不乱（run_output_reset 之类清理帧靠
 * 同一有序缓冲天然保序）。回合收尾（message_end / error）与传输层 finally 也须 flush。
 */
const pendingFrames = new Map<string, RunFrame[]>();

function framesFlushKey(conversationId: string): string {
  return `frames:${conversationId}`;
}

/** 立即写出某会话已缓冲的 frame 批，并取消其挂起的 flush。无缓冲时为 no-op。 */
export function flushPendingFrames(conversationId: string): void {
  const key = framesFlushKey(conversationId);
  cancelCappedFlush(key);
  const buffered = pendingFrames.get(conversationId);
  if (!buffered || buffered.length === 0) {
    pendingFrames.delete(conversationId);
    return;
  }
  pendingFrames.delete(conversationId);
  // Resolve the live turn's slot at flush time (mirrors the per-call resolution the
  // immediate path did). No live assistant message ⇒ nothing to place the frames on.
  const mid = execMessageId(conversationId);
  if (!mid) return;
  useExecutionStore.getState().recordFrames(buffered, mid);
  noteCappedFlush(key);
}

/** 丢弃某会话已缓冲但未写出的执行帧（取消挂起 flush，不 record）。停止生成时用。 */
export function discardPendingFrames(conversationId: string): void {
  resetCappedFlush(framesFlushKey(conversationId));
  pendingFrames.delete(conversationId);
}

/** 把一个高频帧入桶，并确保已排定一次 flush。 */
export function queueFrame(conversationId: string, frame: RunFrame): void {
  const arr = pendingFrames.get(conversationId);
  if (arr) arr.push(frame);
  else pendingFrames.set(conversationId, [frame]);
  scheduleCappedFlush(framesFlushKey(conversationId), () => {
    flushPendingFrames(conversationId);
  });
}
