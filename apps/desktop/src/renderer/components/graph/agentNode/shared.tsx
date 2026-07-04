import { statusPillSoft } from "@/components/ui/tone-presets";
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
  /** Review/QC output flagged by {@link detectReviewConcern} (中间可见性 phase-1). */
  reviewConcern?: ReviewConcernLevel | null;
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
}
