import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import type { ExecutionStatus } from "@/stores/execution";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { CheckCircle2, Loader2, Pause, Sparkles, XCircle } from "lucide-react";

/**
 * 回合摘要节点（前端UX设计.md §6.1）: a completed / running TEAM turn folded
 * into ONE node on the persistent conversation canvas ({@link
 * import("./ConversationCanvas")}). This is the LOD「完成回合折叠成回合摘要节点」rule
 * (§七 节点 ≤50 / ≥60fps) — the canvas accumulates turns as summary nodes; the full
 * worker DAG is drawn only for the focused turn (click → the on-demand full-screen).
 *
 * The face stays minimal (§七 节点 face 极简 — model/token/¥ live in run detail, never
 * the node): status, task summary, the team's identity avatars (stable color + glyph
 * per role via {@link agentColorVar} — the「同一拨人」continuity that is the soul of
 * 乙-1 视觉累积), and a count. A running turn shows live progress.
 */
export interface TurnSummaryData {
  taskSummary: string;
  status: ExecutionStatus;
  /** Distinct member roles, in first-seen order — drives the identity avatars. */
  roles: string[];
  agentCount: number;
  completed: number;
  total: number;
  [key: string]: unknown;
}

const STATUS_STYLES: Record<
  ExecutionStatus,
  { ring: string; icon: React.ReactNode }
> = {
  planning: {
    ring: "ring-muted-foreground/30",
    icon: <Sparkles size={14} className="text-muted-foreground" />,
  },
  running: {
    ring: "ring-primary",
    icon: <Loader2 size={14} className="animate-spin text-primary" />,
  },
  paused: {
    ring: "ring-warning",
    icon: <Pause size={14} className="text-warning" />,
  },
  completed: {
    ring: "ring-success",
    icon: <CheckCircle2 size={14} className="text-success" />,
  },
  failed: {
    ring: "ring-destructive",
    icon: <XCircle size={14} className="text-destructive" />,
  },
  cancelled: {
    ring: "ring-muted-foreground/30",
    icon: <XCircle size={14} className="text-muted-foreground" />,
  },
};

const AVATAR_CAP = 5;

export function TurnSummaryNode({ data }: NodeProps) {
  const d = data as TurnSummaryData;
  const style = STATUS_STYLES[d.status] ?? STATUS_STYLES.planning;
  const running = d.status === "running";
  const shown = d.roles.slice(0, AVATAR_CAP);
  const overflow = d.roles.length - shown.length;
  const pct = d.total > 0 ? (d.completed / d.total) * 100 : 0;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div
        className={`w-[320px] cursor-pointer rounded-xl border bg-card px-3.5 py-3 shadow-sm ring-2 ${style.ring} ${
          running ? "animate-pulse" : ""
        }`}
      >
        <div className="flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
            {style.icon}
          </div>
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {d.taskSummary || "团队回合"}
          </p>
        </div>

        <div className="mt-2.5 flex items-center gap-1.5">
          {shown.map((role, i) => (
            <div
              key={`${role}-${i}`}
              title={role}
              className="flex size-6 items-center justify-center rounded-full text-xs font-semibold"
              style={{
                backgroundColor: `color-mix(in oklab, ${agentColorVar(role)} 18%, transparent)`,
                color: agentColorVar(role),
              }}
            >
              {agentGlyph(role)}
            </div>
          ))}
          {overflow > 0 && (
            <div className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
              +{overflow}
            </div>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {d.agentCount} 个 Agent · {d.completed}/{d.total}
          </span>
        </div>

        {running && (
          <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </>
  );
}
