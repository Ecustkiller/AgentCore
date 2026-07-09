import { statusPillSoft } from "@/components/ui/tone-presets";
import { formatDuration } from "@/lib/format";
import type { ReviewConcernLevel } from "@/lib/reviewConcern";
import type {
  ModelTier,
  PlanRevisionKind,
  ReasoningEffort,
  RunCheckpoint,
  RunStatus,
  Stance,
} from "@/stores/execution";
import { Check, Loader2, X } from "lucide-react";

export interface AgentNodeData {
  agentId: string;
  role: string;
  modelPreference?: ModelTier;
  reasoningEffort?: ReasoningEffort;
  runId: string;
  status: RunStatus;
  isAnimating: boolean;
  task: string;
  outputPreview: string;
  reasoningPreview?: string;
  toolProgress?: { toolName: string; chars: number } | null;
  /** Worker tool EXECUTION phase (transport-only `tool_use_progress` with run_id). */
  toolExecutionLive?: { toolName: string; phase: string } | null;
  tokenCount: number;
  toolCount: number;
  artifacts?: string[];
  focused: boolean;
  layoutMode?: "dependency" | "timeline";
  nodeWidth?: number;
  model?: string | null;
  durationMs?: number | null;
  realTokens?: number;
  costText?: string;
  handleDirection?: "vertical" | "horizontal";
  isSubtask?: boolean;
  isRevision?: boolean;
  revision?: number;
  revised?: PlanRevisionKind | null;
  stance?: Stance | null;
  checkpoint?: RunCheckpoint | null;
  escalationPending?: number;
  escalationRaised?: number;
  /** 该 run 的审计事件数（GraphView 角标；0 或未设则不渲染）。 */
  auditEventCount?: number;
  /** Review/QC output flagged by {@link detectReviewConcern} (中间可见性 phase-1). */
  reviewConcern?: ReviewConcernLevel | null;
  /** Folded child runs under this unit root (delegation drill-in). */
  foldedChildCount?: number;
  unitExpanded?: boolean;
  onToggleUnitExpand?: () => void;
  enterIndex?: number;
  onActivate?: () => void;
  [key: string]: unknown;
}

export const FACE_ARTIFACT_CAP = 2;
export const PEEK_ARTIFACT_CAP = 6;

export const STATUS_STYLES: Record<string, { ring: string; bg: string }> = {
  pending: { ring: "ring-muted-foreground/30", bg: "bg-card" },
  ready: { ring: "ring-muted-foreground/30", bg: "bg-card" },
  running: { ring: "ring-primary", bg: "bg-card" },
  completed: { ring: "ring-success", bg: "bg-card" },
  failed: { ring: "ring-destructive", bg: "bg-card" },
  cancelled: { ring: "ring-muted-foreground/30", bg: "bg-muted" },
};

export const PRESENCE_STYLES: Record<
  string,
  { cls: string; icon: React.ReactNode | null }
> = {
  pending: { cls: "bg-muted-foreground/50", icon: null },
  ready: { cls: "bg-muted-foreground/50", icon: null },
  running: {
    cls: "bg-primary",
    icon: <Loader2 size={9} className="animate-spin text-primary-foreground" />,
  },
  completed: {
    cls: "bg-success",
    icon: (
      <Check size={9} strokeWidth={3} className="text-success-foreground" />
    ),
  },
  failed: {
    cls: "bg-destructive",
    icon: (
      <X size={9} strokeWidth={3} className="text-destructive-foreground" />
    ),
  },
  cancelled: { cls: "bg-muted-foreground/50", icon: null },
};

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

export function statusLabel(status: RunStatus): string {
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

/** Face status line for parallel wave visibility (排队 / 执行 / 完成用时 / 失败). */
export function statusFaceLabel(
  status: RunStatus,
  durationMs: number | null | undefined,
  elapsedSec?: number,
): { text: string; cls: string; tickElapsed: boolean } {
  switch (status) {
    case "pending":
    case "ready":
      return {
        text: "排队中",
        cls: "text-muted-foreground",
        tickElapsed: false,
      };
    case "running": {
      const suffix =
        elapsedSec !== undefined && elapsedSec >= 1 ? ` · ${elapsedSec}s` : "";
      return {
        text: `执行中${suffix}`,
        cls: "text-primary/90",
        tickElapsed: true,
      };
    }
    case "completed": {
      const dur = durationMs ? formatDuration(durationMs) : null;
      return {
        text: dur ? `已完成 · ${dur}` : "已完成",
        cls: "text-muted-foreground",
        tickElapsed: false,
      };
    }
    case "failed":
      return {
        text: "失败",
        cls: "text-destructive",
        tickElapsed: false,
      };
    case "cancelled":
      return {
        text: "已停止",
        cls: "text-muted-foreground",
        tickElapsed: false,
      };
    default:
      return {
        text: statusLabel(status),
        cls: "text-muted-foreground",
        tickElapsed: false,
      };
  }
}

/** 热修修订角标文案（v2 / v3…）；original 为 v1、不在节点上挂角标。 */
export function revisionVersionBadge(
  revision: number | undefined,
): string | null {
  if (!revision || revision <= 1) return null;
  return `v${revision}`;
}

export function revisedBadge(kind: PlanRevisionKind): {
  label: string;
  hint: string;
} {
  if (kind === "bind") {
    return { label: "计划已调整", hint: "CEO 据上游产出定稿了这一步的职责" };
  }
  return { label: "计划已调整", hint: "CEO 据中途发现调整了这一步的方向" };
}

export function checkpointBadge(c: RunCheckpoint): {
  label: string;
  cls: string;
} {
  if (c.status === "pending") {
    return { label: "待放行", cls: statusPillSoft.primary };
  }
  if (c.decision === "stop") {
    return { label: "已停止", cls: statusPillSoft.destructive };
  }
  if (c.decision === "adjust") {
    return { label: "已调整", cls: statusPillSoft.muted };
  }
  return { label: "已放行", cls: statusPillSoft.muted };
}

export interface AgentNodePresentation {
  style: { ring: string; bg: string };
  presence: { cls: string; icon: React.ReactNode | null };
  artifacts: string[];
  liveTool: { toolName: string; chars: number } | null;
  liveToolExec: { toolName: string; phase: string } | null;
  livePreview: string;
  liveThinking: string;
  highlighted: boolean;
  isTimeline: boolean;
  cardWidth: number;
  enterDelay: number;
  modelText: string;
  tokenText: string;
  durationText: string | null;
  ariaLabel: string;
  peekActivity: { heading: string; text: string; italic?: boolean } | null;
  peekTags: string[];
  checkpointFace: { label: string; cls: string } | null;
  reviewConcernFace: { label: string; cls: string } | null;
  statusFace: { text: string; cls: string; tickElapsed: boolean };
  revisionFace: string | null;
}
