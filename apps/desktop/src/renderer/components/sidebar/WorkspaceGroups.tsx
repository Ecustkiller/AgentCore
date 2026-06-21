import { useConversations } from "@/hooks/useConversations";
import { useWorkspaceGroups } from "@/hooks/useWorkspaceGroups";
import { useConversationStore } from "@/stores/conversation";
import { useSidebarStore } from "@/stores/sidebar";
import { ChevronRight, Cloud, HardDrive, MoreHorizontal } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ConversationItem } from "./ConversationItem";

/** Conversations shown inside an expanded group before its「更多」overflow row. */
const MAX_PER_GROUP = 5;

/**
 * The sidebar's「工作区」zone (前端UX §一 方案B): collapsible per-folder groups at the
 * top of the conversation rail, fed by {@link useWorkspaceGroups}. Foldered chats live
 * ONLY here (裸聊 stay in「快速对话」below), so a folder group is the single home for its
 * conversations. Empty folders are hidden; the zone renders nothing when no group
 * exists.
 *
 * Expand state persists per folder (`useSidebarStore.expandedSections`, keyed by
 * folderId): an explicit user toggle always wins; with no stored choice a group
 * defaults collapsed, except the one holding the active conversation (so its
 * siblings are visible while you work). Each group reuses {@link ConversationItem}
 * so rows keep the same status dot / rename / move / archive behavior.
 */
export function WorkspaceGroups() {
  const groups = useWorkspaceGroups();
  const conversations = useConversations();
  const currentId = useConversationStore((s) => s.currentConversationId);
  const expandedSections = useSidebarStore((s) => s.expandedSections);
  const setSection = useSidebarStore((s) => s.setSection);
  const navigate = useNavigate();

  const activeFolderId = useMemo(
    () => conversations.find((c) => c.id === currentId)?.folderId ?? null,
    [conversations, currentId],
  );

  if (groups.length === 0) return null;

  return (
    <div className="space-y-0.5 px-2 pt-2 pb-1">
      {groups.map(({ folder, convs }) => {
        const stored = expandedSections[folder.id];
        const expanded =
          stored !== undefined ? stored : folder.id === activeFolderId;
        const overflow = convs.length - MAX_PER_GROUP;
        return (
          <div key={folder.id}>
            <button
              type="button"
              onClick={() => setSection(folder.id, !expanded)}
              aria-expanded={expanded}
              className="group flex h-9 w-full items-center gap-1.5 rounded-lg px-2 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            >
              {folder.localRootId ? (
                <HardDrive size={14} className="shrink-0 text-primary" />
              ) : (
                <Cloud
                  size={14}
                  className="shrink-0 text-sidebar-foreground/40"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-left">
                {folder.name}
              </span>
              <ChevronRight
                size={14}
                aria-hidden
                className={`shrink-0 text-sidebar-foreground/40 transition-[opacity,transform] ${
                  expanded
                    ? "rotate-90 opacity-100"
                    : "opacity-0 group-hover:opacity-100"
                }`}
              />
            </button>
            {expanded && (
              <div className="space-y-0.5 pl-2">
                {convs.slice(0, MAX_PER_GROUP).map((c) => (
                  <ConversationItem key={c.id} conversation={c} />
                ))}
                {overflow > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      navigate("/conversations", {
                        state: { focusFolderId: folder.id },
                      })
                    }
                    className="flex h-8 w-full items-center gap-1 rounded-lg px-3 text-xs text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  >
                    <MoreHorizontal size={13} className="shrink-0" />
                    更多（{overflow}）
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
