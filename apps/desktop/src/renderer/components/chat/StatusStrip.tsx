import { Badge, Button, IconButton as UiIconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { resolveTurnCost } from "@/lib/cost";
import { formatCost, formatDuration } from "@/lib/format";
import {
  lastUserMessage,
  lastUserMessageId,
  runRegenerate,
} from "@/services/turns";
import {
  activeRuntime,
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
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Pencil,
  Play,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Props every lifecycle strip shares: projection + strip controls. */
export interface StatusStripProps {
  execution: Execution;
  expanded: boolean;
  onToggle: () => void;
  onMaximize: () => void;
  onReplay: () => void;
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
}: StatusStripProps) {
  const isRunning = execution.status === "running";
  const canReplay =
    execution.status === "completed" || execution.status === "cancelled";
  const setConversationView = useUIStore((s) => s.setConversationView);
  const conversationId = useConversationStore((s) => s.currentConversationId);

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
      {conversationId ? (
        <Button
          variant="ghost"
          className="ml-0.5 shrink-0 bg-primary/10 text-primary hover:bg-primary/20"
          icon={<Maximize2 size={13} />}
          onClick={() => setConversationView(conversationId, "canvas")}
        >
          在画布打开
        </Button>
      ) : (
        <StripIconButton
          icon={<Maximize2 size={15} />}
          title="全屏查看协作图"
          onClick={onMaximize}
        />
      )}
    </>
  );
}

function RunningStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
}: StatusStripProps) {
  const { completed, total } = execution.progress;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <Loader2 size={15} className="shrink-0 animate-spin text-primary" />
        <span className="flex flex-1 items-center truncate text-sm font-medium text-foreground">
          {isDebate(execution) && <DebateTag />}
          <span className="truncate">{execution.taskSummary}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {completed}/{total}
        </span>
        <StripControls
          execution={execution}
          expanded={expanded}
          onToggle={onToggle}
          onMaximize={onMaximize}
          onReplay={onReplay}
        />
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: total > 0 ? `${(completed / total) * 100}%` : "0%" }}
        />
      </div>
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
  const failureNotice = `${failedRuns.length} 个子任务失败${failedRolesText}，可重试，或调整指令后重发。`;
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
            {stopped ? "已停止" : isDebate(execution) ? "辩论完成" : "团队完成"}
          </span>
          <span className="text-muted-foreground">
            {` · ${execution.agents.length} 个 Agent · ${completed}/${total} 子任务${
              duration ? ` · 用时 ${duration}` : ""
            }${costSegment}`}
          </span>
        </span>
        <StripControls
          execution={execution}
          expanded={expanded}
          onToggle={onToggle}
          onMaximize={onMaximize}
          onReplay={onReplay}
        />
      </div>

      {showRecovery && (
        <>
          {failedRuns.length > 0 && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{failureNotice}</span>
            </div>
          )}
          <RecoveryActions abandonLabel="忽略" />
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
          {failedRun?.error ?? "未获取到具体错误信息，可重试或调整指令后继续。"}
        </p>
      </div>

      <RecoveryActions />
    </div>
  );
}

/**
 * Shared failure-recovery row: 重试 / 调整指令 / 放弃. Reused by failure and
 * partial-failure strips, and by the canvas 指挥台 ({@link CanvasDecisionPanel}).
 */
export function RecoveryActions({
  abandonLabel = "放弃",
}: {
  abandonLabel?: string;
}) {
  const isGenerating = useActiveGenerating();
  const messageId = useExecutionScope();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (el) {
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
      el.style.height = "0";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [editing]);

  const onRetry = () => {
    const id = lastUserMessageId();
    if (id) void runRegenerate(id);
  };

  const onAdjust = () => {
    const m = lastUserMessage();
    if (!m) return;
    setDraft(m.content);
    setEditing(true);
  };

  const onAdjustSubmit = () => {
    const m = lastUserMessage();
    const text = draft.trim();
    if (!m || !text) return;
    setEditing(false);
    useConversationStore.getState().updateMessage(m.id, { content: text });
    void runRegenerate(m.id, text);
  };

  const onAbandon = () => {
    if (messageId) useExecutionStore.getState().clearExecution(messageId);
  };

  if (editing) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-card p-2">
        <textarea
          ref={editRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "0";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onAdjustSubmit();
            }
          }}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm text-foreground focus:outline-none"
          rows={1}
        />
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <Button
            variant="neutral"
            icon={<X size={13} />}
            onClick={() => setEditing(false)}
          >
            取消
          </Button>
          <Button
            variant="primary"
            icon={<Check size={13} />}
            disabled={!draft.trim()}
            onClick={onAdjustSubmit}
          >
            调整后重发
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Button
        variant="primary"
        icon={<RotateCw size={13} />}
        disabled={isGenerating}
        onClick={onRetry}
      >
        重试
      </Button>
      <Button
        variant="neutral"
        icon={<Pencil size={13} />}
        disabled={isGenerating}
        onClick={onAdjust}
      >
        调整指令
      </Button>
      <Button variant="neutral" icon={<Ban size={13} />} onClick={onAbandon}>
        {abandonLabel}
      </Button>
    </div>
  );
}
