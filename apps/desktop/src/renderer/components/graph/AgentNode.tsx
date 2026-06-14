import { formatCompact } from "@/lib/format";
import {
  MODEL_TIER_META,
  type ModelTier,
  type ReasoningEffort,
  type StepCheckpoint,
  type StepStatus,
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
import { CheckpointBadge } from "./CheckpointBadge";

interface AgentNodeData {
  agentId: string;
  role: string;
  modelPreference?: ModelTier;
  reasoningEffort?: ReasoningEffort;
  stepId: string;
  status: StepStatus;
  isAnimating: boolean;
  outputPreview: string;
  tokenCount: number;
  toolCount: number;
  focused: boolean;
  checkpoint: StepCheckpoint | null;
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

export function AgentNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const style = STATUS_STYLES[d.status] ?? STATUS_STYLES.pending;
  const isRunning = d.status === "running";
  const showPreview =
    (isRunning || d.status === "completed") && !!d.outputPreview;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div
        className={`w-[210px] rounded-xl border px-3 py-2.5 ring-2 shadow-sm ${style.bg} ${style.ring} ${isRunning ? "animate-pulse" : ""} ${d.focused ? "outline outline-2 outline-offset-2 outline-primary" : ""}`}
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

        {(d.toolCount > 0 || d.checkpoint) && (
          <div className="mt-1.5 flex items-center gap-2">
            {d.toolCount > 0 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Wrench size={11} />
                <span className="tabular-nums">{d.toolCount}</span>
              </div>
            )}
            {d.checkpoint && <CheckpointBadge checkpoint={d.checkpoint} />}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </>
  );
}

function statusLabel(status: StepStatus): string {
  const labels: Record<StepStatus, string> = {
    pending: "等待中",
    ready: "就绪",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}
