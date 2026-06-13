import { Trash2 } from "lucide-react";
import { useState } from "react";
import {
  useConversationStore,
  type Conversation,
} from "@/stores/conversation";

interface Props {
  conversation: Conversation;
}

export function ConversationItem({ conversation }: Props) {
  const [hovered, setHovered] = useState(false);
  const currentId = useConversationStore((s) => s.currentConversationId);
  const setCurrentConversation = useConversationStore(
    (s) => s.setCurrentConversation,
  );
  const removeConversation = useConversationStore(
    (s) => s.removeConversation,
  );
  const isActive = conversation.id === currentId;

  return (
    <button
      type="button"
      className={`group flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      }`}
      onClick={() => setCurrentConversation(conversation.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="flex-1 truncate text-left">{conversation.title}</span>
      {hovered && (
        <span
          role="button"
          tabIndex={-1}
          className="flex size-6 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-destructive"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              removeConversation(conversation.id);
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            removeConversation(conversation.id);
          }}
        >
          <Trash2 size={13} />
        </span>
      )}
    </button>
  );
}
