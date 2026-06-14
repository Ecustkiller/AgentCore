import { formatCompact, formatDuration } from "@/lib/format";
import {
  MODEL_TIER_META,
  type ModelTier,
  type ReasoningEffort,
  type RunStatus,
} from "@/stores/execution";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  Bot,
  CheckCircle2,
  Loader2,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { useTerminalFlash } from "./useTerminalFlash";

interface AgentNodeData {
  agentId: string;
  role: string;
  modelPreference?: ModelTier;
  reasoningEffort?: ReasoningEffort;
  runId: string;
  status: RunStatus;
  isAnimating: boolean;
  outputPreview: string;
  tokenCount: number;
  toolCount: number;
  focused: boolean;
  /** Billed model id (run_completed); null until the run finishes. */
  model?: string | null;
  /** Wall-clock run duration in ms; null until the run finishes. */
  durationMs?: number | null;
  /** Real billed tokens (input+output) once metered; 0 while streaming. */
  realTokens?: number;
  /** Edge anchor orientation, driven by the active graph layout. */
  handleDirection?: "vertical" | "horizontal";
  /** Position in the plan, used to stagger the entrance animation. */
  enterIndex?: number;
  /** Keyboard activation (Enter/Space) — mirrors a plain node click. */
  onActivate?: () => void;
  [key: string]: unknown;
}

const TIER_BADGE_STYLES: Record<ModelTier, string> = {
  strong: "bg-primary/10 text-primary",
  fast: "bg-muted text-muted-foreground",
};

const STATUS_STYLES: Record<
  string,
  { ring: string; bg: string; icon: React.ReactNode }
> = {
  pending: {
    ring: "ring-muted-foreground/30",
    bg: "bg-card",
    icon: <Bot size={16} className="text-muted-foreground" />,
  },
  ready: {
    ring: "ring-muted-foreground/30",
    bg: "bg-card",
    icon: <Bot size={16} className="text-muted-foreground" />,
  },
  running: {
    ring: "ring-primary",
    bg: "bg-card",
    icon: <Loader2 size={16} className="animate-spin text-primary" />,
  },
  completed: {
    ring: "ring-success",
    bg: "bg-card",
    icon: <CheckCircle2 size={16} className="text-success" />,
  },
  failed: {
    ring: "ring-destructive",
    bg: "bg-card",
    icon: <XCircle size={16} className="text-destructive" />,
  },
  cancelled: {
    ring: "ring-muted-foreground/30",
    bg: "bg-muted",
    icon: <XCircle size={16} className="text-muted-foreground" />,
  },
};

export function AgentNode({ data, selected }: NodeProps) {
  const d = data as AgentNodeData;
  const style = STATUS_STYLES[d.status] ?? STATUS_STYLES.pending;
  const isRunning = d.status === "running";
  const horizontal = d.handleDirection === "horizontal";
  const highlighted = d.focused || selected;
  const flashing = useTerminalFlash(d.status);
  const flashColor =
    d.status === "failed" ? "var(--destructive)" : "var(--success)";
  // Cascade entrance by plan order, capped so big teams still finish promptly.
  const enterDelay = Math.min((d.enterIndex ?? 0) * 35, 280);
  const showPreview =
    (isRunning || d.status === "completed") && !!d.outputPreview;

  // Tooltip facts: prefer the real metered numbers once the run finishes, fall
  // back to the streaming estimate / tier label while it is still running.
  const modelText =
    d.model ??
    (d.modelPreference ? MODEL_TIER_META[d.modelPreference].label : "—");
  const tokenText =
    d.realTokens && d.realTokens > 0
      ? formatCompact(d.realTokens)
      : d.tokenCount > 0
        ? `≈${formatCompact(d.tokenCount)}`
        : "—";
  const durationText = d.durationMs ? formatDuration(d.durationMs) : null;
  // The same facts power the screen-reader label, since the visual tooltip is
  // aria-hidden (it is a pointer/keyboard affordance, not its own a11y node).
  const ariaLabel = `${d.role}，${statusLabel(d.status)}，模型 ${modelText}，Token ${tokenText}${
    durationText ? `，用时 ${durationText}` : ""
  }${d.toolCount > 0 ? `，工具 ${d.toolCount} 次` : ""}`;

  return (
    <>
      <Handle
        type="target"
        position={horizontal ? Position.Left : Position.Top}
        className="!bg-border"
      />
      {/* Entrance wrapper: keeps the once-on-mount scale/fade off the card so it
          never collides with the card's running `animate-pulse` (both set the CSS
          `animation` property). */}
      <div
        className="animate-graph-node-enter"
        style={{ animationDelay: `${enterDelay}ms` }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: a graph node is a composite (icon + multi-line text + badges + nested tooltip) that a native <button> may not contain; it is keyboard-activable via role + onKeyDown. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              d.onActivate?.();
            }
          }}
          style={{ "--graph-flash-color": flashColor } as React.CSSProperties}
          className={`group relative w-[210px] cursor-default rounded-xl border px-3 py-2.5 text-left shadow-sm outline-none ring-2 ${style.bg} ${style.ring} ${isRunning ? "animate-pulse" : ""} ${flashing ? "animate-graph-node-flash" : ""} ${
            highlighted
              ? "outline outline-2 outline-offset-2 outline-primary"
              : "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
              {style.icon}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {d.role}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {statusLabel(d.status)}
              </p>
            </div>
            {d.modelPreference && (
              <span
                title={MODEL_TIER_META[d.modelPreference].label}
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${TIER_BADGE_STYLES[d.modelPreference]}`}
              >
                {MODEL_TIER_META[d.modelPreference].short}
              </span>
            )}
            {d.reasoningEffort === "max" && (
              <span
                title="深度思考 (max)"
                className="flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
              >
                <Sparkles size={10} />
                深度
              </span>
            )}
            {d.tokenCount > 0 && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                ≈{formatCompact(d.tokenCount)}
              </span>
            )}
          </div>

          {showPreview && (
            <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/80">
              {d.outputPreview}
              {isRunning && (
                <span className="ml-0.5 inline-block animate-pulse text-primary">
                  ▋
                </span>
              )}
            </p>
          )}

          {d.toolCount > 0 && (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Wrench size={11} />
                <span className="tabular-nums">{d.toolCount}</span>
              </div>
            </div>
          )}

          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-full left-1/2 z-20 mt-2 hidden w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-md group-hover:block group-focus-visible:block"
          >
            <dl className="flex flex-col gap-1 text-xs">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">模型</dt>
                <dd className="truncate font-medium text-foreground">
                  {modelText}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Token</dt>
                <dd className="font-medium tabular-nums text-foreground">
                  {tokenText}
                </dd>
              </div>
              {durationText && (
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">用时</dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    {durationText}
                  </dd>
                </div>
              )}
              {d.toolCount > 0 && (
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">工具</dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    {d.toolCount} 次
                  </dd>
                </div>
              )}
            </dl>
          </div>
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

function statusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    pending: "等待中",
    ready: "就绪",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已停止",
  };
  return labels[status] ?? status;
}
