import { debatePreviewSubtitle } from "@/components/chat/debate/debateEntryCopy";
import { Badge, Button, IconButton as UiIconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { resolveTurnCost } from "@/lib/cost";
import { formatCost, formatDuration } from "@/lib/format";
import { acceptRunOutcome } from "@/services/runRedirect";
import {
  lastUserMessageId,
  runRegenerate,
  runRetryFailed,
} from "@/services/turns";
import {
  activeRuntime,
  getActiveRuntime,
  selectLastAssistantCostTotal,
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import {
  type Execution,
  elapsedMs,
  isDebate,
  useActiveExecField,
  useExecutionScope,
  useExecutionStore,
} from "@/stores/execution";
import { useUsageStore } from "@/stores/usage";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  History,
  Loader2,
  Maximize2,
  MessagesSquare,
  Play,
  RotateCw,
  Square,
} from "lucide-react";

/** Props every lifecycle strip shares: projection + strip controls. */
export interface StatusStripProps {
  execution: Execution;
  expanded: boolean;
  onToggle: () => void;
  onMaximize: () => void;
  onReplay: () => void;
  /** Open the first in-flight worker in the side detail panel (中间可见性). */
  onPeekRunning?: () => void;
  /** 定向唤回「修订 vN」的回合：聊天正文不再内联版本对比大卡，改由状态条「改了 N 版」信号 chip
   *  深链画布放大态统一「对比」视图（前端UX设计.md §4.2/§6.4）。无修订 / 未提供则不出 chip。 */
  onOpenRevisions?: () => void;
  /** Expand the in-chat team-notes wall (and scroll it into view). */
  onOpenTeamNotes?: () => void;
  /** 协作质量轻信号（message_end.collab）；有非零才显。 */
  collabSummary?: string | null;
}

/**
 * Lifecycle header row above the collaboration graph (前端UX设计.md §三).
 * Dispatches to running / completed / cancelled / failed variants.
 */
export function StatusStrip(props: StatusStripProps) {
  switch (props.execution.status) {
    case "completed":
      return <CompletedStrip {...props} />;
    case "cancelled":
      return <CompletedStrip {...props} stopped />;
    case "failed":
      return <FailureStrip {...props} />;
    default:
      return <RunningStrip {...props} />;
  }
}

function DebateTag() {
  return (
    <Badge tone="primary" pill className="mr-1.5 align-middle font-medium">
      辩论
    </Badge>
  );
}

function StripIconButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <SimpleTooltip label={title}>
      <UiIconButton type="button" onClick={onClick} aria-label={title}>
        {icon}
      </UiIconButton>
    </SimpleTooltip>
  );
}

function StripControls({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
  onOpenRevisions,
  collabSummary,
}: StatusStripProps) {
  const isRunning = execution.status === "running";
  const canReplay =
    execution.status === "completed" || execution.status === "cancelled";
  const debate = isDebate(execution);
  // 「改了 N 版」仅计定向唤回热修；辩论 continue_run（陈词/质询/结辩）不是修订。
  const revisionCount = debate
    ? 0
    : execution.runs.filter((r) => r.revisionOf != null).length;

  return (
    <>
      {isRunning && (
        <StripIconButton
          icon={<Square size={15} />}
          title="停止任务"
          onClick={() => useConversationStore.getState().stopGeneration()}
        />
      )}
      {canReplay && (
        <StripIconButton
          icon={<Play size={15} />}
          title="回放协作过程"
          onClick={onReplay}
        />
      )}
      <StripIconButton
        icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        title={expanded ? "收起协作图" : "展开协作图"}
        onClick={onToggle}
      />
      {/* 「改了 N 版」信号：本回合有定向唤回续写时，正文不再内联版本对比大卡，改为一枚 chip →
          深链画布放大态统一「对比」视图并排比对（前端UX设计.md §4.2/§6.4）。 */}
      {revisionCount > 0 && onOpenRevisions && (
        <SimpleTooltip label="查看各版本并排对比（在画布）">
          <Button
            variant="ghost"
            className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
            icon={<History size={13} />}
            onClick={onOpenRevisions}
          >
            改了 {revisionCount} 版
          </Button>
        </SimpleTooltip>
      )}
      {collabSummary && (
        <SimpleTooltip label="本回合协作质量信号（明细见诊断）">
          <span className="ml-0.5 max-w-[14rem] truncate text-xs text-muted-foreground">
            {collabSummary}
          </span>
        </SimpleTooltip>
      )}
      {/* 入口：辩论回合给醒目「打开辩论室」CTA（更可发现、直达群聊主视图），其余给通用「在画布打开」；
          二者同去处（放大态 Route A），辩论默认落群聊、回放走同一去处 + 自动播放。 */}
      <Button
        variant="ghost"
        className="ml-0.5 shrink-0 bg-primary/10 text-primary hover:bg-primary/20"
        icon={debate ? <MessagesSquare size={13} /> : <Maximize2 size={13} />}
        onClick={onMaximize}
      >
        {debate ? "打开辩论室" : "在画布打开"}
      </Button>
    </>
  );
}

function RunningStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
  onOpenRevisions,
  onPeekRunning,
  onOpenTeamNotes,
  collabSummary,
}: StatusStripProps) {
  const { completed, total } = execution.progress;
  const runningRuns = execution.runs.filter((r) => r.status === "running");
  const noteCount = execution.teamNotes.length;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <Loader2 size={15} className="shrink-0 animate-spin text-primary" />
        <span className="flex flex-1 items-center truncate text-sm font-medium text-foreground">
          {isDebate(execution) && <DebateTag />}
          <span className="truncate">
            {isDebate(execution)
              ? debatePreviewSubtitle(execution)
              : execution.taskSummary}
          </span>
        </span>
        {!isDebate(execution) && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {completed}/{total}
          </span>
        )}
        <StripControls
          execution={execution}
          expanded={expanded}
          onToggle={onToggle}
          onMaximize={onMaximize}
          onReplay={onReplay}
          onOpenRevisions={onOpenRevisions}
          collabSummary={collabSummary}
        />
      </div>
      {runningRuns.length > 0 && onPeekRunning && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{runningRuns.length} 人正在干活，节点上会实时显示输出预览</span>
          <Button
            variant="ghost"
            className="h-7 shrink-0 px-2 text-primary hover:bg-primary/10"
            onClick={onPeekRunning}
          >
            查看进行中
          </Button>
        </div>
      )}
      {noteCount > 0 && onOpenTeamNotes && (
        <div className="mt-2 flex items-center gap-2">
          <SimpleTooltip label="展开团队便签">
            <button
              type="button"
              className="inline-flex"
              onClick={onOpenTeamNotes}
              aria-label={`展开团队便签，共 ${noteCount} 条`}
            >
              <Badge tone="primary" pill className="font-medium">
                团队便签 {noteCount}
              </Badge>
            </button>
          </SimpleTooltip>
        </div>
      )}
      <TeamSynthesisPreviewLine />
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: total > 0 ? `${(completed / total) * 100}%` : "0%" }}
        />
      </div>
    </div>
  );
}

/** CEO 协调模式：多 worker 进展 / 合成草稿预览（transport-only，运行中可见）。 */
function TeamSynthesisPreviewLine() {
  const preview = useActiveExecField((rt) => rt.teamSynthesisPreview);
  if (!preview) return null;
  const blurbs = preview.workers.filter(
    (w) => w.status !== "pending" && w.summary,
  );
  // update_synthesis 路径：workers=[]、text=草稿正文；确定性进度路径：text≈headline+blurbs。
  // 有 worker 摘要时用列表；否则把 text 当草稿正文渲染（避免只见 headline、不见草稿）。
  const draftBody =
    blurbs.length === 0 &&
    preview.text.trim() &&
    preview.text.trim() !== preview.headline.trim()
      ? preview.text.trim()
      : null;
  return (
    <div
      className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
      data-testid="team-synthesis-preview"
    >
      <div className="flex items-center gap-2">
        <Badge tone="primary" pill className="font-medium">
          {preview.in_progress ? "进展中" : "团队进展"}
        </Badge>
        <span className="truncate font-medium text-foreground">
          {preview.headline}
        </span>
      </div>
      {blurbs.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-0.5">
          {blurbs.map((w) => (
            <li key={w.run_id} className="truncate">
              · {w.role}：{w.summary}
            </li>
          ))}
        </ul>
      )}
      {draftBody && (
        <p
          className="mt-1.5 whitespace-pre-wrap text-foreground/80"
          data-testid="team-synthesis-draft"
        >
          {draftBody}
        </p>
      )}
    </div>
  );
}

function CompletedStrip({
  execution,
  stopped,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
  onOpenRevisions,
  collabSummary,
}: StatusStripProps & { stopped?: boolean }) {
  const frames = useActiveExecField((rt) => rt.frames);
  const { completed, total } = execution.progress;
  const ms = elapsedMs(frames);
  const duration = ms > 0 ? formatDuration(ms) : "";

  const failedRuns = execution.runs.filter((s) => s.status === "failed");
  const failedRoles = failedRuns
    .map((s) => execution.agents.find((a) => a.id === s.agentId)?.role)
    .filter((r): r is string => Boolean(r));
  const failedRolesText =
    failedRoles.length > 0 ? `：${failedRoles.join("、")}` : "";
  const failureNotice = `${failedRuns.length} 个子任务失败${failedRolesText}，可重试或忽略。`;
  const showRecovery = stopped || failedRuns.length > 0;

  const turnCostTotal = useConversationStore((s) =>
    selectLastAssistantCostTotal(activeRuntime(s).messages),
  );
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const costTotal = resolveTurnCost(
    turnCostTotal,
    execution.runs.map((r) => r.cost?.total ?? 0),
  );
  const costSegment =
    costTotal && costTotal > 0
      ? ` · ${stopped ? "已花 " : ""}${formatCost(costTotal, cnyPerUsd)}`
      : "";

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        {stopped ? (
          <Square size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <CheckCircle2 size={15} className="shrink-0 text-success" />
        )}
        <span className="flex-1 text-sm text-foreground">
          {!stopped && isDebate(execution) && <DebateTag />}
          <span className="font-medium">
            {stopped
              ? "已停止"
              : isDebate(execution)
                ? debatePreviewSubtitle(execution)
                : "团队完成"}
          </span>
          {!isDebate(execution) && (
            <span className="text-muted-foreground">
              {` · ${execution.agents.length} 个 Agent · ${completed}/${total} 子任务${
                duration ? ` · 用时 ${duration}` : ""
              }${costSegment}`}
            </span>
          )}
        </span>
        <StripControls
          execution={execution}
          expanded={expanded}
          onToggle={onToggle}
          onMaximize={onMaximize}
          onReplay={onReplay}
          onOpenRevisions={onOpenRevisions}
          collabSummary={collabSummary}
        />
      </div>

      {showRecovery && (
        <>
          {failedRuns.length > 0 && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{failureNotice}</span>
            </div>
          )}
          <RecoveryActions
            abandonLabel="忽略"
            hasFailedRuns={failedRuns.length > 0}
          />
        </>
      )}
    </div>
  );
}

function FailureStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
  onOpenRevisions,
  collabSummary,
}: StatusStripProps) {
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);

  const failedRun = execution.runs.find((s) => s.status === "failed") ?? null;
  const failedAgent = failedRun
    ? (execution.agents.find((a) => a.id === failedRun.agentId) ?? null)
    : null;

  const spent = resolveTurnCost(
    null,
    execution.runs.map((r) => r.cost?.total ?? 0),
  );
  const spentText = spent != null ? formatCost(spent, cnyPerUsd) : null;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="shrink-0 text-destructive" />
        <span className="flex-1 text-sm text-foreground">
          <span className="font-medium">任务失败</span>
          {spentText && (
            <span className="text-muted-foreground">{` · 已花 ${spentText}`}</span>
          )}
        </span>
        <StripControls
          execution={execution}
          expanded={expanded}
          onToggle={onToggle}
          onMaximize={onMaximize}
          onReplay={onReplay}
          onOpenRevisions={onOpenRevisions}
          collabSummary={collabSummary}
        />
      </div>

      <div className="mt-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
        {failedAgent || failedRun ? (
          <p className="text-foreground">
            {failedAgent && (
              <span className="font-medium">{failedAgent.role}</span>
            )}
            {failedRun && (
              <span className="text-muted-foreground"> · {failedRun.task}</span>
            )}
          </p>
        ) : (
          <p className="text-foreground">执行过程中出现错误</p>
        )}
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">
          {failedRun?.error ?? "未获取到具体错误信息，可重试或忽略。"}
        </p>
      </div>

      <RecoveryActions />
    </div>
  );
}

/** Resolve the user message that opened the focused assistant turn (救火绑聚焦回合). */
function userMessageIdForAssistant(
  assistantMessageId: string | null,
): string | null {
  if (!assistantMessageId) return lastUserMessageId();
  const msgs = getActiveRuntime().messages;
  const idx = msgs.findIndex(
    (m) =>
      m.id === assistantMessageId || m.serverMessageId === assistantMessageId,
  );
  if (idx <= 0) return lastUserMessageId();
  for (let i = idx - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].id;
  }
  return lastUserMessageId();
}

/**
 * Shared failure-recovery row: 重试 / 放弃. Reused by failure and partial-failure
 * strips, and by the canvas 指挥台 ({@link CanvasDecisionPanel}).
 */
export function RecoveryActions({
  abandonLabel = "放弃",
  hasFailedRuns = false,
}: {
  abandonLabel?: string;
  /** When true, show "重试失败项" (retry-failed) as the primary action;
   *  otherwise fall back to "重试" (full regenerate). */
  hasFailedRuns?: boolean;
}) {
  const isGenerating = useActiveGenerating();
  const messageId = useExecutionScope();
  const conversationId = useConversationStore((s) => s.currentConversationId);

  const onRetryFailed = () => {
    const id = userMessageIdForAssistant(messageId);
    if (id) void runRetryFailed(id);
  };

  const onRegenerate = () => {
    const id = userMessageIdForAssistant(messageId);
    if (id) void runRegenerate(id);
  };

  const onAbandon = () => {
    if (!messageId) return;
    // 忽略可审计：best-effort 记一条 recovery_ignored（turn 级），再清本地投影。
    if (conversationId) {
      void acceptRunOutcome(conversationId, {
        messageId,
        runId: messageId,
        reason: "recovery_ignored",
        note: "用户在救火行选择忽略",
      }).catch(() => {
        /* local clear still proceeds */
      });
    }
    useExecutionStore.getState().clearExecution(messageId);
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {hasFailedRuns ? (
        <>
          <Button
            variant="primary"
            icon={<RotateCw size={13} />}
            disabled={isGenerating}
            onClick={onRetryFailed}
          >
            重试失败项
          </Button>
          <Button
            variant="neutral"
            icon={<RotateCw size={13} />}
            disabled={isGenerating}
            onClick={onRegenerate}
          >
            全部重新生成
          </Button>
        </>
      ) : (
        <Button
          variant="primary"
          icon={<RotateCw size={13} />}
          disabled={isGenerating}
          onClick={onRegenerate}
        >
          重试
        </Button>
      )}
      <Button variant="neutral" icon={<Ban size={13} />} onClick={onAbandon}>
        {abandonLabel}
      </Button>
    </div>
  );
}
