import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatCompact, formatDuration } from "@/lib/format";
import {
  MODEL_TIER_META,
  type ModelTier,
  type ReasoningEffort,
  type RunCheckpoint,
  type RunStatus,
  STANCE_META,
  type Stance,
} from "@/stores/execution";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  Bot,
  CheckCircle2,
  Clock,
  CornerDownRight,
  History,
  Loader2,
  Pause,
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
  /** This worker's assigned task (run.task). The node's stable "在干什么" line —
   * shown whenever it is not actively streaming its own output. */
  task: string;
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
  /** Pre-formatted ¥ run cost (e.g.「¥0.05」); undefined until priced or when
   * zero. Computed in GraphView (it owns the single FX rate). No longer drawn on
   * the card face (¥ lives in the run-detail 资源消耗 panel, §7.3B); kept only to
   * feed the screen-reader aria-label. */
  costText?: string;
  /** Edge anchor orientation, driven by the active graph layout. */
  handleDirection?: "vertical" | "horizontal";
  /** 阶段2: this run is a nested sub-worker (delegated by another worker), so the
   * card carries a 子任务 badge to set it apart from a top-level teammate. */
  isSubtask?: boolean;
  /** 乙 热修 P4: this node is a 定向唤回 续写 of an original run; `revision` is its
   * version number (≥2), shown as a「修订 vN」badge so a re-do reads as a version
   * of the same worker rather than a new teammate. */
  isRevision?: boolean;
  revision?: number;
  /** 辩论/审查 side (前端UX设计.md §四): badges the node 正方/反方; null/undefined on
   * an ordinary teammate. */
  stance?: Stance | null;
  /** 结构化挂起 2a (7.2A): a `checkpoint_after` pause that fired after this run, or
   * null. Drives the node's「待放行 / 已放行 / 已停止」pause badge. */
  checkpoint?: RunCheckpoint | null;
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

  // Shared facts for the card chip and the a11y label: prefer the real metered
  // numbers once the run finishes, fall back to the streaming estimate / tier
  // label while it is still running.
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
  // 节点 face 保持简洁「角色 → 在干什么 → 用时/工具」，数字类（model / token / ¥）
  // 不上卡片、全部归右侧 run 详情面板的「资源消耗」区段；这里仍算出来只为喂下方
  // 屏幕阅读器 aria-label（无障碍仍播报完整事实）。用时则真正画在脚注。
  const ariaLabel = `${d.role}，${statusLabel(d.status)}，模型 ${modelText}，Token ${tokenText}${
    d.costText ? `，成本 ${d.costText}` : ""
  }${durationText ? `，用时 ${durationText}` : ""}${
    d.toolCount > 0 ? `，工具 ${d.toolCount} 次` : ""
  }${d.checkpoint ? `，检查点${checkpointBadge(d.checkpoint).label}` : ""}`;

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
        {/* biome-ignore lint/a11y/useSemanticElements: a graph node is a composite (icon + multi-line text + badges) that a native <button> may not contain; it is keyboard-activable via role + onKeyDown. */}
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
          className={`relative w-[210px] cursor-default rounded-xl border px-3 py-2.5 text-left shadow-sm outline-none ring-2 ${style.bg} ${style.ring} ${isRunning ? "animate-pulse" : ""} ${flashing ? "animate-graph-node-flash" : ""} ${
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
              {/* 第二行仅在有「立场 / 子任务 / 修订」分类标记时出现；状态不再用文字
                  重复（图标 + 色环 + 运行脉冲已表达），普通队员只剩单行角色名，不再被
                  徽章挤到截断。 */}
              {(d.stance || d.isSubtask || d.isRevision || d.checkpoint) && (
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {d.stance && (
                    <span className="shrink-0 rounded-full bg-info/10 px-1.5 py-0.5 font-medium text-info">
                      {STANCE_META[d.stance].label}
                    </span>
                  )}
                  {d.isSubtask && (
                    <span className="flex shrink-0 items-center gap-1">
                      <CornerDownRight size={10} className="text-primary/70" />
                      子任务
                    </span>
                  )}
                  {d.isRevision && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-info/10 px-1.5 py-0.5 font-medium text-info">
                      <History size={10} />
                      修订 v{d.revision ?? 2}
                    </span>
                  )}
                  {d.checkpoint &&
                    (() => {
                      const badge = checkpointBadge(d.checkpoint);
                      return (
                        <span
                          className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${badge.cls}`}
                        >
                          <Pause size={10} />
                          {badge.label}
                        </span>
                      );
                    })()}
                </p>
              )}
            </div>
            {d.modelPreference && (
              <SimpleTooltip label={MODEL_TIER_META[d.modelPreference].label}>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${TIER_BADGE_STYLES[d.modelPreference]}`}
                >
                  {MODEL_TIER_META[d.modelPreference].short}
                </span>
              </SimpleTooltip>
            )}
            {d.reasoningEffort === "max" && (
              <SimpleTooltip label="深度思考 (max)">
                <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                  <Sparkles size={10} />
                  深度
                </span>
              </SimpleTooltip>
            )}
          </div>

          {/* 中行 = 这个节点「在干什么」：运行中显自己的流式输出（带光标），其余
              状态显被分配的任务一句话（run.task），取代过去取输出末尾 80 字、对文件/
              代码而言纯属乱码的 tailText 预览。 */}
          {isRunning
            ? d.outputPreview && (
                <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/80">
                  {d.outputPreview}
                  <span className="ml-0.5 inline-block animate-pulse text-primary">
                    ▋
                  </span>
                </p>
              )
            : d.task && (
                <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground/70">
                  {d.task}
                </p>
              )}

          {/* 脚注只留「用时 · 工具数」两个轻信号；¥ / token 已移交 run 详情面板。 */}
          {(durationText || d.toolCount > 0) && (
            <div className="mt-1.5 flex items-center gap-2.5 text-xs text-muted-foreground">
              {durationText && (
                <span className="flex items-center gap-1">
                  <Clock size={11} />
                  <span className="tabular-nums">{durationText}</span>
                </span>
              )}
              {d.toolCount > 0 && (
                <span className="flex items-center gap-1">
                  <Wrench size={11} />
                  <span className="tabular-nums">{d.toolCount}</span>
                </span>
              )}
            </div>
          )}
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

/** The pause-badge label + palette for a node's structured checkpoint (plan_review,
 * 结构化挂起): 待放行 while the user has not answered, then 已放行 (continued) / 已调整
 * (continued with a steer injected downstream) / 已停止 (the run ended here). A
 * timeout folds in as 已放行 (the engine continued). */
function checkpointBadge(c: RunCheckpoint): { label: string; cls: string } {
  if (c.status === "pending") {
    return { label: "待放行", cls: "bg-warning/10 text-warning" };
  }
  if (c.decision === "stop") {
    return { label: "已停止", cls: "bg-destructive/10 text-destructive" };
  }
  if (c.decision === "adjust") {
    return { label: "已调整", cls: "bg-muted text-muted-foreground" };
  }
  return { label: "已放行", cls: "bg-muted text-muted-foreground" };
}
