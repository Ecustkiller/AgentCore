import { WindowControls } from "@/components/layout/WindowControls";
import { WindowFrameMenu } from "@/components/layout/WindowFrameMenu";
import { IconButton, TitleBarSearchTrigger } from "@/components/ui";
import { isMac, macTitleBarInsetClass } from "@/lib/platform";
import { useSidebarStore } from "@/stores/sidebar";
import { useUIStore } from "@/stores/ui";
import { PanelLeft, PanelLeftClose } from "lucide-react";

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
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
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
        <WindowFrameMenu />
        <TitleBarSearchTrigger onClick={() => openSearch()} />

        <WindowControls />
      </div>
    </header>
  );
}
