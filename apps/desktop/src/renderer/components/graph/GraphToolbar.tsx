import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { GraphLayout } from "@/stores/graph";
import { Maximize2 } from "lucide-react";
import { LAYOUT_OPTIONS } from "./constants";

interface GraphToolbarProps {
  layoutKind: GraphLayout;
  onLayoutKindChange: (kind: GraphLayout) => void;
  onFitView: () => void;
}

export function GraphToolbar({
  layoutKind,
  onLayoutKindChange,
  onFitView,
}: GraphToolbarProps) {
  return (
    <div
      className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-1 shadow-sm backdrop-blur"
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
      <div className="mx-0.5 h-5 w-px bg-border" />
      <SimpleTooltip label="适应画布 (F)">
        <IconButton onClick={onFitView} aria-label="适应画布">
          <Maximize2 size={14} />
        </IconButton>
      </SimpleTooltip>
    </div>
  );
}
