import { createFolder } from "@/services/folders";
import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { useSidebarStore } from "@/stores/sidebar";
import {
  Compass,
  FolderOpen,
  FolderPlus,
  Mail,
  MessageSquare,
  Plus,
  Search,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ConversationList } from "./ConversationList";
import { UserMenu } from "./UserMenu";

const NAV_ITEMS = [
  { icon: MessageSquare, label: "对话", route: "/" },
  { icon: Mail, label: "消息", route: "/messages" },
  { icon: FolderOpen, label: "文件", route: "/files" },
  { icon: Wrench, label: "工具箱", route: "/toolbox" },
  { icon: Compass, label: "探索", route: "/explore" },
] as const;

export function Sidebar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const conversations = useConversationStore((s) => s.conversations);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const isNavActive = (route: string) =>
    route === "/"
      ? pathname === "/" || pathname.startsWith("/conversations")
      : pathname === route || pathname.startsWith(`${route}/`);

  const handleNewConversation = () => {
    // 新对话先以草稿态存在（不落库），首条消息发送时由 MessageInput 真正创建后端会话。
    // A plain new chat is ungrouped: clear any folder draft target left pending.
    useFoldersStore.getState().setPendingNewChatFolder(null);
    setQuery("");
    switchConversation(null);
    navigate("/");
  };

  const handleNewFolder = async () => {
    try {
      const folder = await createFolder("新建文件夹");
      const store = useFoldersStore.getState();
      store.addFolder(folder);
      // Open the new folder's header straight into rename mode.
      store.setPendingRename(folder.id);
    } catch {
      /* create failed (offline / 401); the sidebar stays as-is */
    }
  };

  return (
    <aside
      className={`flex flex-shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ${collapsed ? "w-14" : "w-60"}`}
      style={{ backgroundImage: "var(--sidebar-gradient)" }}
    >
      {/* Navigation */}
      <nav className="space-y-0.5 px-2 pt-2 pb-2">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item.route);
          return (
            <button
              key={item.route}
              type="button"
              onClick={() => navigate(item.route)}
              className={`flex h-9 w-full items-center gap-3 rounded-lg text-base ${collapsed ? "justify-center px-0" : "px-3"} ${
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <item.icon size={18} className="shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Divider + Conversation header */}
      <div className="mx-3 border-t border-sidebar-border" />
      {!collapsed && (
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <span className="text-xs font-medium text-sidebar-foreground/50">
            对话
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => void handleNewFolder()}
              title="新建文件夹"
              aria-label="新建文件夹"
              className="flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <FolderPlus size={14} />
            </button>
            <button
              type="button"
              onClick={handleNewConversation}
              title="新建对话"
              aria-label="新建对话"
              className="flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Search (non-scrolling, only when there are conversations to filter) */}
      {!collapsed && conversations.length > 0 && (
        <div className="px-3 pb-2 pt-1">
          <div className="flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent/50 px-2.5">
            <Search size={14} className="shrink-0 text-sidebar-foreground/40" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索对话"
              className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/40 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="清除搜索"
                className="shrink-0 text-sidebar-foreground/40 hover:text-sidebar-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Conversation list (scrollable, takes remaining space) */}
      <div className="flex-1 overflow-y-auto">
        {!collapsed && <ConversationList query={query} />}
      </div>

      {/* Footer: User menu */}
      <UserMenu />
    </aside>
  );
}
