import { useActiveMessageFocus } from "@/stores/conversation";
import { useEffect, useRef, useState } from "react";
import { AssistantMessage } from "./AssistantMessage";
import type { MessageBubbleProps } from "./types";
import { UserMessage } from "./UserMessage";

export function MessageBubble({ message }: MessageBubbleProps) {
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
      className={`scroll-mt-6 rounded-xl transition-shadow ${
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
}

export type { MessageBubbleProps } from "./types";
