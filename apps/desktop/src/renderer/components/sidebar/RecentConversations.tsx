import { SurfaceRowButton } from "@/components/ui";
import { useConversations } from "@/hooks/useConversations";
import { useWorkspaceGroups } from "@/hooks/useWorkspaceGroups";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { ChevronRight, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ConversationItem } from "./ConversationItem";

/** How many 裸聊 the「快速对话」zone shows before deferring to /conversations.
 * Adaptive: with no「工作区」groups the zone owns the whole rail ({@link BARE_LIMIT_SOLO});
 * once groups sit above it the cap relaxes to {@link BARE_LIMIT_WITH_GROUPS} because
 * workspaces already occupy the priority fold. Overflow exits via「查看全部对话」. */
const BARE_LIMIT_SOLO = 15;
const BARE_LIMIT_WITH_GROUPS = 10;

function byPinnedThenRecency(a: Conversation, b: Conversation): number {
  // Pinned float to the top (置顶对话); within each group, newest activity first.
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/**
 * The rail's bare-chat zone (前端UX §一 方案B): **裸聊 (folderless chats)** below the
 * workspace groups, capped adaptively (see {@link BARE_LIMIT_SOLO}). Foldered chats live
 * ONLY in their {@link useWorkspaceGroups} group (干净二分零重复). The currently-open bare
 * chat is always pinned in even when older than the cut-off (a foldered active chat
 * shows in its auto-expanded group instead).
 *
 * No section title — group headers (cloud/local icon + trailing chevron) vs flat
 * {@link ConversationItem} rows carry the IA. When both zones exist, a hairline divider
 * separates them. When every chat is foldered this zone renders nothing.
 */
export function RecentConversations() {
  const conversations = useConversations();
  const hasGroups = useWorkspaceGroups().length > 0;
  const currentId = useConversationStore((s) => s.currentConversationId);

  const recent = useMemo(() => {
    const limit = hasGroups ? BARE_LIMIT_WITH_GROUPS : BARE_LIMIT_SOLO;
    const bare = conversations
      .filter((c) => !c.folderId)
      .sort(byPinnedThenRecency);
    const top = bare.slice(0, limit);
    if (currentId && !top.some((c) => c.id === currentId)) {
      const active = bare.find((c) => c.id === currentId);
      if (active) top.push(active); // keep an out-of-window active bare chat visible
    }
    return top;
  }, [conversations, currentId, hasGroups]);

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <MessageSquare size={24} className="text-sidebar-foreground/30" />
        <p className="text-sm text-sidebar-foreground/50">暂无对话</p>
        <p className="text-xs text-sidebar-foreground/40">开始第一次对话 →</p>
      </div>
    );
  }

  // Every chat is foldered → no 裸聊 to show; the「工作区」zone carries the rail.
  if (recent.length === 0) return null;

  return (
    <div
      className={`px-2 py-1 ${hasGroups ? "mx-3 border-t border-sidebar-border pt-2" : ""}`}
    >
      <div className="space-y-0.5">
        {recent.map((conv) => (
          <ConversationItem key={conv.id} conversation={conv} />
        ))}
      </div>
    </div>
  );
}

/**
 * The「查看全部对话」entry into the full management page (/conversations). Lives at the
 * very bottom of the rail's conversation area — after「工作区」+「快速对话」— so it's
 * the single overflow exit for everything (older 裸聊, extra workspaces, per-group
 * overflow). Hidden when there are no conversations at all.
 */
export function ViewAllConversations() {
  const count = useConversations().length;
  const navigate = useNavigate();
  if (count === 0) return null;
  return (
    <div className="px-2 pb-2">
      <SurfaceRowButton
        onClick={() => navigate("/conversations")}
        className="justify-between text-sidebar-foreground/55 hover:text-sidebar-foreground"
      >
        <span>查看全部对话</span>
        <ChevronRight size={14} className="shrink-0" />
      </SurfaceRowButton>
    </div>
  );
}
