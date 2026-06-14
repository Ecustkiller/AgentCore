import { useActiveMessages } from "@/stores/conversation";
import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble";

export function MessageList() {
  const messages = useActiveMessages();
  const bottomRef = useRef<HTMLDivElement>(null);

  const lastMessage = messages[messages.length - 1];
  // Track both content and reasoning length so the view also follows the live
  // "thinking" stream during the reasoning phase (before any content arrives).
  const scrollTrigger = lastMessage
    ? `${lastMessage.id}-${lastMessage.content.length}-${lastMessage.reasoning?.length ?? 0}`
    : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollTrigger is an intentional re-run key (content + reasoning length); the effect body only scrolls.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scrollTrigger]);

  return (
    <div className="space-y-6">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
