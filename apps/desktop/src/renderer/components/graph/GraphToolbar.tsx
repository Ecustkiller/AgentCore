import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { GraphLayout } from "@/stores/graph";
import { LAYOUT_OPTIONS } from "./constants";

interface GraphToolbarProps {
  layoutKind: GraphLayout;
  onLayoutKindChange: (kind: GraphLayout) => void;
}

/**
 * 放大态 layout selector (top-right). Zoom + fit moved to the shared
 * {@link import("./CanvasZoomControls")} cluster (bottom-left, unified with the 总览态),
 * so this toolbar now selects the ELK layout only.
 */
export function GraphToolbar({
  layoutKind,
  onLayoutKindChange,
}: GraphToolbarProps) {
  return (
    <div
      className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-card/90 p-1 shadow-sm backdrop-blur"
      onContextMenu={(e) => e.stopPropagation()}
    >
      {LAYOUT_OPTIONS.map((opt) => (
        <SimpleTooltip key={opt.kind} label={opt.label}>
          <IconButton
            onClick={() => onLayoutKindChange(opt.kind)}
            aria-label={opt.label}
            aria-pressed={layoutKind === opt.kind}
            className={
              layoutKind === opt.kind
                ? "bg-accent text-foreground hover:bg-accent hover:text-foreground"
                : undefined
            }
          >
            {opt.icon}
          </IconButton>
        </SimpleTooltip>
      ))}
    </div>
  );
}
