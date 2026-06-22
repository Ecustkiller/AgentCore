import { WindowControls } from "@/components/layout/WindowControls";
import { Button, IconButton } from "@/components/ui";
import { isMac, macTitleBarInsetClass } from "@/lib/platform";
import { chord } from "@/lib/shortcuts";
import { useSidebarStore } from "@/stores/sidebar";
import { useUIStore } from "@/stores/ui";
import { PanelLeft, PanelLeftClose, Search } from "lucide-react";

export function TitleBar() {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const openSearch = useUIStore((s) => s.openSearch);

  return (
    <header
      className={`flex h-10 shrink-0 items-center border-b border-sidebar-border bg-sidebar [-webkit-app-region:drag] ${isMac ? macTitleBarInsetClass : ""}`}
    >
      {/* Left: brand + sidebar toggle — width syncs with sidebar */}
      <div
        className={`flex items-center gap-2 px-3 transition-[width] duration-200 ${collapsed ? "w-14" : "w-60"}`}
      >
        {!collapsed && (
          <span className="flex flex-1 items-center gap-1.5 text-sm font-semibold text-sidebar-foreground [-webkit-app-region:no-drag]">
            AgentCore
            {import.meta.env.DEV && (
              <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-xs font-medium text-warning">
                DEV
              </span>
            )}
          </span>
        )}
        <IconButton
          tone="sidebar"
          onClick={toggleCollapsed}
          className="[-webkit-app-region:no-drag]"
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </IconButton>
      </div>

      {/* Drag spacer */}
      <div className="flex-1" />

      {/* Search trigger + window controls (Win/Linux; macOS uses traffic lights) */}
      <div className="flex items-center [-webkit-app-region:no-drag]">
        <Button
          variant="neutral"
          onClick={openSearch}
          icon={<Search size={13} className="shrink-0" />}
          className="mr-2 h-7 gap-2 border border-sidebar-border px-3 text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          搜索…{" "}
          <kbd className="text-xs text-sidebar-foreground/40">{chord("k")}</kbd>
        </Button>

        <WindowControls />
      </div>
    </header>
  );
}
