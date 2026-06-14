import { useSidebarStore } from "@/stores/sidebar";
import { useUIStore } from "@/stores/ui";
import {
  Minus,
  PanelLeft,
  PanelLeftClose,
  Search,
  Square,
  X,
} from "lucide-react";

export function TitleBar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const openSearch = useUIStore((s) => s.openSearch);

  return (
    <header className="flex h-10 shrink-0 items-center border-b border-sidebar-border bg-sidebar [-webkit-app-region:drag]">
      {/* Left: brand + sidebar toggle — width syncs with sidebar */}
      <div
        className={`flex items-center gap-2 px-3 transition-[width] duration-200 ${collapsed ? "w-14" : "w-60"}`}
      >
        {!collapsed && (
          <span className="flex-1 text-sm font-semibold text-sidebar-foreground [-webkit-app-region:no-drag]">
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

      {/* Drag spacer */}
      <div className="flex-1" />

      {/* Search trigger + window controls */}
      <div className="flex items-center [-webkit-app-region:no-drag]">
        <button
          type="button"
          onClick={openSearch}
          className="mr-2 flex h-7 items-center gap-2 rounded-lg border border-sidebar-border px-3 text-sm text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent"
        >
          <Search size={13} className="shrink-0" />
          <span>搜索对话…</span>
          <kbd className="text-xs text-sidebar-foreground/40">Ctrl+K</kbd>
        </button>

        <button
          type="button"
          onClick={() => window.windowApi.minimize()}
          className="flex h-10 w-12 items-center justify-center text-sidebar-foreground/60 hover:bg-sidebar-accent"
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          onClick={() => window.windowApi.maximize()}
          className="flex h-10 w-12 items-center justify-center text-sidebar-foreground/60 hover:bg-sidebar-accent"
        >
          <Square size={12} />
        </button>
        <button
          type="button"
          onClick={() => window.windowApi.close()}
          className="flex h-10 w-12 items-center justify-center text-sidebar-foreground/60 hover:bg-destructive hover:text-destructive-foreground"
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
