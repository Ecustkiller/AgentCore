import { useConversations } from "@/hooks/useConversations";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { ChevronRight, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ConversationItem } from "./ConversationItem";

/** How many recent conversations the slimmed sidebar shows before「查看全部对话」.
 * The full list (with folders) lives on the /conversations management page. */
const RECENT_LIMIT = 8;

function byRecency(a: Conversation, b: Conversation): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/**
 * The sidebar's compact conversation list: the {@link RECENT_LIMIT} most recent
 * chats (flat, folder grouping ignored) plus a「查看全部对话」entry into the
 * full management page. The currently-open chat is always pinned in even when it
 * is older than the cut-off, so the active row never disappears from the rail.
 */
export function RecentConversations() {
  const conversations = useConversations();
  const currentId = useConversationStore((s) => s.currentConversationId);
  const navigate = useNavigate();

  const recent = useMemo(() => {
    const sorted = [...conversations].sort(byRecency);
    const top = sorted.slice(0, RECENT_LIMIT);
    if (currentId && !top.some((c) => c.id === currentId)) {
      const active = sorted.find((c) => c.id === currentId);
      if (active) top.push(active);
    }
    return top;
  }, [conversations, currentId]);

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <MessageSquare size={24} className="text-sidebar-foreground/30" />
        <p className="text-sm text-sidebar-foreground/50">暂无对话</p>
        <p className="text-xs text-sidebar-foreground/40">开始第一次对话 →</p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 px-2 py-1">
      {recent.map((conv) => (
        <ConversationItem key={conv.id} conversation={conv} />
      ))}
      <button
        type="button"
        onClick={() => navigate("/conversations")}
        className="mt-1 flex h-9 w-full items-center justify-between gap-2 rounded-lg px-3 text-sm text-sidebar-foreground/55 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      >
        <span>查看全部对话</span>
        <ChevronRight size={14} className="shrink-0" />
      </button>
    </div>
  );
}
