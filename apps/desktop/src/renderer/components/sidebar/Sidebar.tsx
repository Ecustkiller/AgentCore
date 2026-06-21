import { startNewConversation } from "@/lib/newConversation";
import { useUnreadTotal } from "@/stores/messaging";
import { useSidebarStore } from "@/stores/sidebar";
import {
  Compass,
  Files,
  Mail,
  MessageSquare,
  Wrench,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  RecentConversations,
  ViewAllConversations,
} from "./RecentConversations";
import { UserMenu } from "./UserMenu";
import { WorkspaceGroups } from "./WorkspaceGroups";

const NAV_ITEMS = [
  { icon: MessageSquare, label: "对话", route: "/" },
  { icon: Files, label: "文件", route: "/files" },
  { icon: Mail, label: "消息", route: "/messages" },
  { icon: Wrench, label: "工具箱", route: "/toolbox" },
  { icon: Compass, label: "探索", route: "/explore" },
] as const;

export function Sidebar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const unread = useUnreadTotal();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // 「对话」(route "/") 既是「新建对话」动作、又兼作对话区的区段指示：仅在「没有具体会话被
  // 选中」的状态下高亮——空白草稿 `/` 与「全部对话」页 `/conversations`；一旦进入具体会话
  // `/conversations/:id`，高亮就让位给下方最近列表里的那条会话行（避免导航与会话行双重高亮）。
  // 其余导航是普通区段 tab，落在该区段（含子路由）即整段高亮。
  const isNavActive = (route: string) =>
    route === "/"
      ? pathname === "/" || pathname === "/conversations"
      : pathname === route || pathname.startsWith(`${route}/`);

  // 「对话」入口默认就是新建一个空白对话；回到旧对话走下方列表 /「全部对话」。
  const handleNewConversation = () => startNewConversation(navigate);

  return (
    <aside
      className={`flex flex-shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ${collapsed ? "w-14" : "w-60"}`}
      style={{ backgroundImage: "var(--sidebar-gradient)" }}
    >
      {/* Navigation */}
      <nav className="space-y-0.5 px-2 pt-2 pb-2">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item.route);
          const showBadge = item.route === "/messages" && unread > 0;
          return (
            <button
              key={item.route}
              type="button"
              onClick={() =>
                item.route === "/"
                  ? handleNewConversation()
                  : navigate(item.route)
              }
              className={`relative flex h-9 w-full items-center gap-3 rounded-lg text-base ${collapsed ? "justify-center px-0" : "px-3"} ${
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <item.icon size={18} className="shrink-0" />
              {!collapsed && (
                <span className="flex-1 text-left">{item.label}</span>
              )}
              {showBadge &&
                (collapsed ? (
                  <span
                    aria-label={`${unread} 条未读`}
                    className="absolute right-2 top-1.5 size-2 rounded-full bg-primary"
                  />
                ) : (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground">
                    {unread > 99 ? "99+" : unread}
                  </span>
                ))}
            </button>
          );
        })}
      </nav>

      {/* Divider — nav vs conversation list */}
      <div className="mx-3 border-t border-sidebar-border" />

      {/* 工作区 (collapsible folder groups) + 快速对话 (裸聊 flat list); full list
          lives on /conversations (前端UX §一 方案B). */}
      <div className="flex-1 overflow-y-auto">
        {!collapsed && (
          <>
            <WorkspaceGroups />
            <RecentConversations />
            <ViewAllConversations />
          </>
        )}
      </div>

      {/* Footer: User menu */}
      <UserMenu />
    </aside>
  );
}
