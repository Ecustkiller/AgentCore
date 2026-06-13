import { MessageSquare } from "lucide-react";
import { useConversationStore } from "@/stores/conversation";
import { ConversationItem } from "./ConversationItem";

export function ConversationList() {
  const conversations = useConversationStore((s) => s.conversations);

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <MessageSquare size={24} className="text-sidebar-foreground/30" />
        <p className="text-sm text-sidebar-foreground/50">暂无对话</p>
        <p className="text-xs text-sidebar-foreground/40">
          开始第一次对话 →
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 px-2 py-1">
      {conversations.map((conv) => (
        <ConversationItem key={conv.id} conversation={conv} />
      ))}
    </div>
  );
}
