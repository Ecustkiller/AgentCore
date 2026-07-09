import { stopLabel } from "@/components/chat/debate/model/labels";
import {
  graphBadgeMuted,
  graphBadgePrimary,
} from "@/components/ui/tone-presets";
import { formatDuration } from "@/lib/format";
import type { RunStatus } from "@/stores/execution";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ChevronDown, ChevronRight, Loader2, MessagesSquare } from "lucide-react";
import { statusFaceLabel } from "./agentNode/shared";
import { useTerminalFlash } from "./useTerminalFlash";

export interface DebateCompoundNodeData {
  runId: string;
  motion: string | null;
  roundCount: number;
  stopReason: string | null;
  durationMs: number | null;
  status: RunStatus;
  childCount: number;
  expanded: boolean;
  focused: boolean;
  handleDirection: "horizontal" | "vertical";
  enterIndex?: number;
  onActivate?: () => void;
  onToggleExpand?: () => void;
  [key: string]: unknown;
}

const STATUS_RING: Record<string, string> = {
  pending: "ring-muted-foreground/30",
  ready: "ring-muted-foreground/30",
  running: "ring-primary",
  completed: "ring-success",
  failed: "ring-destructive",
  cancelled: "ring-muted-foreground/30",
};

export function DebateCompoundNode({ data }: NodeProps) {
  const d = data as DebateCompoundNodeData;
  const horizontal = d.handleDirection === "horizontal";
  const flashing = useTerminalFlash(d.status);
  const flashColor =
    d.status === "failed" ? "var(--destructive)" : "var(--success)";
  const isRunning = d.status === "running";
  const enterDelay = (d.enterIndex ?? 0) * 40;

  return (
    <>
      <Handle
        type="target"
        position={horizontal ? Position.Left : Position.Top}
        className="!bg-border"
      />
      <div
        className="animate-graph-node-enter"
        style={{ animationDelay: `${enterDelay}ms` }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: graph card hosts nested controls */}
        <div
          role="button"
          tabIndex={0}
          aria-label={`辩论：${d.motion ?? "进行中"}`}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              d.onActivate?.();
            }
          }}
          style={
            {
              "--graph-flash-color": flashColor,
              width: 240,
            } as React.CSSProperties
          }
          className={`relative cursor-pointer rounded-xl border border-primary/20 bg-card px-3 py-2.5 text-left shadow-sm outline-none ring-2 ${STATUS_RING[d.status] ?? STATUS_RING.pending} ${
            isRunning ? "animate-pulse" : ""
          } ${flashing ? "animate-graph-node-flash" : ""} ${
            d.focused
              ? "outline outline-2 outline-offset-2 outline-primary"
              : "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60"
          }`}
        >
          <div className="flex items-start gap-2">
            <span
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${graphBadgePrimary}`}
            >
              <MessagesSquare size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-foreground">
                  辩论
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${graphBadgeMuted}`}
                >
                  {d.roundCount > 0 ? `${d.roundCount} 轮` : "进行中"}
                </span>
              </div>
              {d.motion ? (
                <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
                  {d.motion}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  多轮交锋 · {d.childCount} 个辩手 run
                </p>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {isRunning ? (
              <span className="inline-flex items-center gap-1 text-primary">
                <Loader2 size={11} className="animate-spin" />
                进行中
              </span>
            ) : (
              <span>{statusFaceLabel(d.status, d.durationMs).text}</span>
            )}
            {d.stopReason && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span>{stopLabel(d.stopReason)}</span>
              </>
            )}
            {d.durationMs != null && d.durationMs > 0 && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span>{formatDuration(d.durationMs)}</span>
              </>
            )}
          </div>
          <button
            type="button"
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-border/60 bg-muted/30 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              d.onToggleExpand?.();
            }}
          >
            {d.expanded ? (
              <>
                <ChevronDown size={12} />
                收起内部结构
              </>
            ) : (
              <>
                <ChevronRight size={12} />
                展开轮次结构
              </>
            )}
          </button>
        </div>
      </div>
      <Handle
        type="source"
        position={horizontal ? Position.Right : Position.Bottom}
        className="!bg-border"
      />
    </>
  );
}
