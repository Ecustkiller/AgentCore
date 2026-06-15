import { useActiveMessages } from "@/stores/conversation";
import { MessageBubble } from "./MessageBubble";

// Auto-scroll lives in ChatView's useStickToBottom: it owns the scroll container
// and only follows new content while the user is already at the bottom.
export function MessageList() {
  const messages = useActiveMessages();

  return (
    <div className="space-y-6">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
}
