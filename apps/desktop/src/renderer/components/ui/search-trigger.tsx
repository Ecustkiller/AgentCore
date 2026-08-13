import { Button, IconButton } from "@/components/ui";
import { chord } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";

/** Fake input that opens the global command palette (Cmd/Ctrl+K). */
export function SearchTrigger({
  collapsed = false,
  onClick,
  className,
}: {
  collapsed?: boolean;
  onClick: () => void;
  className?: string;
}) {
  if (collapsed) {
    return (
      <div className={cn("flex justify-center", className)}>
        <IconButton
          tone="sidebar"
          onClick={onClick}
          aria-label="搜索或运行命令"
        >
          <Search size={16} />
        </IconButton>
      </div>
    );
  }

  return (
    <Button
      variant="neutral"
      onClick={onClick}
      icon={<Search size={14} className="shrink-0" />}
      className={cn(
        "w-full justify-start gap-2 bg-sidebar-accent/70 px-3 text-sm font-normal text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground",
        className,
      )}
    >
      搜索或运行命令
      <kbd className="ml-auto shrink-0 text-xs text-sidebar-foreground/40">
        {chord("k")}
      </kbd>
    </Button>
  );
}

/**
 * Compact trigger for the desktop title bar (not full-width).
 *
 * Filled rather than outlined, and held a full 16px off the min/max/close cluster:
 * an outlined chip sitting on the same-colour bar right next to the window controls
 * reads as a browser tab, not as a search field.
 */
export function TitleBarSearchTrigger({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="neutral"
      onClick={onClick}
      icon={<Search size={14} className="shrink-0" />}
      className={cn(
        "mr-4 h-7 w-56 justify-start gap-2 bg-sidebar-accent/70 px-2.5 text-sm font-normal text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground",
        className,
      )}
    >
      搜索或运行命令
      <kbd className="ml-auto shrink-0 text-xs text-sidebar-foreground/40">
        {chord("k")}
      </kbd>
    </Button>
  );
}
