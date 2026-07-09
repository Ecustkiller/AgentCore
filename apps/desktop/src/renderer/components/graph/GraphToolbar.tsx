import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { GraphLayout } from "@/stores/graph";
import { GitBranch } from "lucide-react";
import { LAYOUT_OPTIONS } from "./constants";

interface GraphToolbarProps {
  layoutKind: GraphLayout;
  onLayoutKindChange: (kind: GraphLayout) => void;
  /** Scheduling summary from `batch_metrics` — shown when the turn has parallel workers. */
  metricsSummary?: string | null;
  /** Whether this turn has enough timing data for timeline layout. */
  timelineAvailable?: boolean;
  /** Multi-agent turn with audit inject paths available. */
  injectFlowAvailable?: boolean;
  showAuditInjectFlow?: boolean;
  onShowAuditInjectFlowChange?: (on: boolean) => void;
}

/**
 * 放大态 layout selector (top-right). Zoom + fit moved to the shared
 * {@link import("./CanvasZoomControls")} cluster (bottom-left, unified with the 总览态).
 * Dependency layouts (左右流 / 树形) plus optional 时间轴 when batch_metrics exists.
 */
export function GraphToolbar({
  layoutKind,
  onLayoutKindChange,
  metricsSummary,
  timelineAvailable = false,
  injectFlowAvailable = false,
  showAuditInjectFlow = false,
  onShowAuditInjectFlowChange,
}: GraphToolbarProps) {
  return (
    <div
      className="absolute right-3 top-3 z-10 flex items-center gap-2"
      onContextMenu={(e) => e.stopPropagation()}
    >
      {metricsSummary && (
        <SimpleTooltip label="真实时间轴：重叠＝真并行 · 空档＝并发上限排队 · 最长条＝关键路径">
          <span className="rounded-lg border border-border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            {metricsSummary}
          </span>
        </SimpleTooltip>
      )}
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card/90 p-1 shadow-sm backdrop-blur">
        {injectFlowAvailable && onShowAuditInjectFlowChange && (
          <SimpleTooltip label="始终显示审计数据流（默认仅在打开 run 详情时高亮）">
            <span className="inline-flex">
              <IconButton
                onClick={() =>
                  onShowAuditInjectFlowChange(!showAuditInjectFlow)
                }
                aria-label="显示审计数据流"
                aria-pressed={showAuditInjectFlow}
                className={
                  showAuditInjectFlow
                    ? "bg-accent text-foreground hover:bg-accent hover:text-foreground"
                    : undefined
                }
              >
                <GitBranch size={14} />
              </IconButton>
            </span>
          </SimpleTooltip>
        )}
        {LAYOUT_OPTIONS.map((opt) => {
          const disabled = !!opt.requiresParallelTimeline && !timelineAvailable;
          const tip =
            opt.kind === "timeline" && disabled
              ? "调度结束后可查看时间布局（需 ≥2 个队员）"
              : opt.label;
          return (
            <SimpleTooltip key={opt.kind} label={tip}>
              <span className="inline-flex">
                <IconButton
                  onClick={() => !disabled && onLayoutKindChange(opt.kind)}
                  disabled={disabled}
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
              </span>
            </SimpleTooltip>
          );
        })}
      </div>
    </div>
  );
}
