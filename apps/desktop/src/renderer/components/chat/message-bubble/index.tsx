import { isExecutionHarvestMessage } from "@/lib/executionHarvest";
import { turnOutcomeForAssistant } from "@/lib/turnOutcome";
import { cn } from "@/lib/utils";
import {
  useActiveMessageFocus,
  useLiveTailWriting,
} from "@/stores/conversation";
import { memo, useEffect, useRef } from "react";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import type { MessageBubbleProps } from "./types";

/**
 * 长输出流式性能 (白屏卡死修复·Stage 3): a streaming turn rewrites ONLY the last message
 * object each rAF tick — the conversation store's append mutators spread a fresh object
 * for the tail and keep every earlier message's identity — so memoizing on the `message`
 * reference lets every finished bubble skip the per-tick re-render; only the live tail
 * re-renders while the model streams. The focus subscription still re-runs all bubbles on
 * a jump-to-message (rare), which is what drives scroll-into-view.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
}: MessageBubbleProps) {
  const focus = useActiveMessageFocus();
  const liveTailWriting = useLiveTailWriting(message.id);
  const ref = useRef<HTMLDivElement>(null);
  // Capture on first mount: a streaming placeholder must not replay enter
  // when sendTurn reuses the bubble, and must not start fading in on the
  // first token (adding the class later would play the animation then).
  const skipEnterAnim = useRef(
    message.role === "assistant" && message.isStreaming,
  ).current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus.nonce is an intentional re-run key
  useEffect(() => {
    // Permalink may target serverMessageId while the bubble still keys on client id.
    if (focus?.id !== message.id && focus?.id !== message.serverMessageId) {
      return;
    }
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focus?.id, focus?.nonce, message.id, message.serverMessageId]);

  // 合成收口行：不渲染芯片，也不走用户气泡（避免露出模型提示词）。
  if (isExecutionHarvestMessage(message)) {
    return null;
  }
  // 空壳整泡不渲染的唯一列表入口（仲裁器 hideEmptyBubble：空停止，以及没有团队图的空失败）。
  // 气泡内部不再叠 isUserStopped / 正文挡板；协作图 StatusStrip 仍可画「已停止」。
  // 本轮还在写时按直播尾处理，不能只看 message.isStreaming（hydrate settle
  // 可能先把占位转成空壳）。
  if (
    message.role === "assistant" &&
    turnOutcomeForAssistant(message, null, {
      isStreaming: message.isStreaming || liveTailWriting,
    }).hideEmptyBubble
  ) {
    return null;
  }

  const isAssistant = message.role === "assistant";
  return (
    <div
      ref={ref}
      className={cn(
        "scroll-mt-6 rounded-xl",
        !skipEnterAnim && "animate-message-enter motion-reduce:animate-none",
      )}
    >
      {isAssistant ? (
        <AssistantMessage message={message} />
      ) : (
        <UserMessage message={message} />
      )}
    </div>
  );
});

export type { MessageBubbleProps } from "./types";
