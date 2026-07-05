import { useActiveMessageFocus } from "@/stores/conversation";
import { memo, useEffect, useRef, useState } from "react";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import type { MessageBubbleProps } from "./types";

/**
 * 长输出流式性能 (白屏卡死修复·Stage 3): a streaming turn rewrites ONLY the last message
 * object each rAF tick — the conversation store's append mutators spread a fresh object
 * for the tail and keep every earlier message's identity — so memoizing on the `message`
 * reference lets every finished bubble skip the per-tick re-render; only the live tail
 * re-renders while the model streams. The focus subscription still re-runs all bubbles on
 * a jump-to-message (rare), which is what drives the scroll-into-view flash.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
}: MessageBubbleProps) {
  const focus = useActiveMessageFocus();
  const ref = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus.nonce is an intentional re-run key
  useEffect(() => {
    if (focus?.id !== message.id) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [focus?.id, focus?.nonce, message.id]);

  return (
    <div
      ref={ref}
      className={`scroll-mt-6 rounded-xl transition-shadow animate-message-enter motion-reduce:animate-none ${
        flash ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      {message.role === "user" ? (
        <UserMessage message={message} />
      ) : (
        <AssistantMessage message={message} />
      )}
    </div>
  );
});

export type { MessageBubbleProps } from "./types";
