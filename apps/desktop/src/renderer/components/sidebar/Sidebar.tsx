import {
  Compass,
  FolderOpen,
  Mail,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Wrench,
} from "lucide-react";
import { useSidebarStore } from "@/stores/sidebar";
import { ConversationList } from "./ConversationList";

const NAV_ITEMS = [
  { icon: MessageSquare, label: "对话", route: "/" },
  { icon: Mail, label: "消息", route: "/messages" },
  { icon: FolderOpen, label: "文件", route: "/files" },
  { icon: Wrench, label: "工具箱", route: "/toolbox" },
  { icon: Compass, label: "探索", route: "/explore" },
] as const;

export function Sidebar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);

  return (
    <aside
      className={`flex flex-shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ${collapsed ? "w-14" : "w-60"}`}
      style={{ backgroundImage: "var(--sidebar-gradient)" }}
    >
      {/* Brand header */}
      <div className="flex h-10 items-center gap-2 px-3 [-webkit-app-region:drag]">
        {!collapsed && (
          <span className="flex-1 text-base font-semibold [-webkit-app-region:no-drag]">
            AgentCore
          </span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent [-webkit-app-region:no-drag]"
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* Search */}
      <div className="px-2 pb-1">
        {collapsed ? (
          <button
            type="button"
            className="flex size-8 mx-auto items-center justify-center rounded-lg text-sidebar-foreground/50 hover:bg-sidebar-accent"
          >
            <Search size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border px-3 text-sm text-sidebar-foreground/40 hover:border-sidebar-foreground/20"
          >
            <Search size={14} />
            <span>搜索…</span>
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="space-y-0.5 px-2 pb-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.route}
            type="button"
            className={`flex h-9 w-full items-center gap-3 rounded-lg text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${collapsed ? "justify-center px-0" : "px-3"}`}
          >
            <item.icon size={16} className="shrink-0" />
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* Divider + Conversation header */}
      <div className="mx-3 border-t border-sidebar-border" />
      {!collapsed && (
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <span className="text-xs font-medium text-sidebar-foreground/50">
            对话
          </span>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-lg text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus size={14} />
          </button>
        </div>
      )}

      {/* Conversation list (scrollable, takes remaining space) */}
      <div className="flex-1 overflow-y-auto">
        {!collapsed && <ConversationList />}
      </div>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-2">
        <button
          type="button"
          className={`flex h-9 w-full items-center gap-3 rounded-lg text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${collapsed ? "justify-center px-0" : "px-3"}`}
        >
          <Settings size={16} className="shrink-0" />
          {!collapsed && <span>设置</span>}
        </button>
      </div>
    </aside>
  );
}
