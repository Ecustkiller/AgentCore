import { copyText } from "@/lib/clipboard";
import { resolveTurnCost } from "@/lib/cost";
import { formatCost, formatDuration } from "@/lib/format";
import {
  lastUserMessage,
  lastUserMessageId,
  runRegenerate,
} from "@/services/turns";
import { useConversationStore } from "@/stores/conversation";
import { useDetailPanelStore } from "@/stores/detailPanel";
import {
  type Execution,
  elapsedMs,
  useExecutionStore,
  useProjectedExecution,
} from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  RotateCw,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The in-chat "team dashboard" — the core visual difference from a plain chat
 * AI. Renders the task lifecycle as a compact signal (running progress /
 * completed scorecard / failure recovery); the roomy Layer-2 view (roster +
 * per-run drill-down) lives in the {@link DetailPanel}, reached via the entry
 * row. Single-agent turns carry no plan and never show a card.
 */
export function TaskCard() {
  const execution = useProjectedExecution();
  if (!execution || execution.planType === "single_agent") return null;

  // Stable wrapper so the entrance animation plays once when the card first
  // mounts on `run_plan`; inner status swaps (running→completed/failed) reuse
  // this element and never re-trigger it.
  return (
    <div className="animate-task-card-enter">
      <TaskCardBody execution={execution} />
    </div>
  );
}

function TaskCardBody({ execution }: { execution: Execution }) {
  switch (execution.status) {
    case "completed":
      return <CompletedCard execution={execution} />;
    case "cancelled":
      return <CompletedCard execution={execution} stopped />;
    case "failed":
      return <FailureCard execution={execution} />;
    default:
      return <RunningCard execution={execution} />;
  }
}

/** Circular icon button used across the card headers. */
function IconButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {icon}
    </button>
  );
}

/**
 * Entry into the detail panel's roomy team view. The single bridge from the
 * inline card to Layer 2 — the card itself stays a compact signal.
 */
function TeamDetailEntry({ agentCount }: { agentCount: number }) {
  const openProgress = useDetailPanelStore((s) => s.openProgress);
  return (
    <button
      type="button"
      onClick={() => openProgress()}
      className="mt-3 flex w-full items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-left text-sm hover:bg-accent"
    >
      <span className="text-muted-foreground">{agentCount} 个 Agent 协作</span>
      <span className="flex items-center gap-0.5 text-primary">
        查看团队详情
        <ChevronRight size={14} />
      </span>
    </button>
  );
}

/** Overflow menu — the manager's controls over the running/finished team. */
function TaskMenu({ execution }: { execution: Execution }) {
  const [open, setOpen] = useState(false);
  const isRunning = execution.status === "running";

  const onStop = () => {
    useConversationStore.getState().stopGeneration();
    setOpen(false);
  };
  const onReplan = () => {
    const id = lastUserMessageId();
    if (id) void runRegenerate(id);
    setOpen(false);
  };
  const onCopyId = () => {
    void copyText(execution.id);
    setOpen(false);
  };

  return (
    <div className="relative">
      <IconButton
        icon={<MoreHorizontal size={15} />}
        title="更多"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <>
          <button
            type="button"
            aria-label="关闭菜单"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-8 z-20 min-w-36 overflow-hidden rounded-lg border border-border bg-popover py-1 text-sm shadow-lg">
            {isRunning && (
              <MenuItem
                icon={<Square size={13} />}
                label="停止任务"
                onClick={onStop}
              />
            )}
            <MenuItem
              icon={<RotateCcw size={13} />}
              label="重新规划"
              onClick={onReplan}
            />
            <MenuItem
              icon={<Copy size={13} />}
              label="复制任务 ID"
              onClick={onCopyId}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-popover-foreground hover:bg-accent"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Active execution: live progress bar + entry into the team detail panel. */
function RunningCard({ execution }: { execution: Execution }) {
  const openGraph = useUIStore((s) => s.openGraph);
  const { completed, total } = execution.progress;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Loader2 size={15} className="shrink-0 animate-spin text-primary" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {execution.taskSummary}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {completed}/{total}
        </span>
        <IconButton
          icon={<Workflow size={15} />}
          title="查看协作图"
          onClick={openGraph}
        />
        <TaskMenu execution={execution} />
      </div>

      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: total > 0 ? `${(completed / total) * 100}%` : "0%" }}
        />
      </div>

      <TeamDetailEntry agentCount={execution.agents.length} />
    </div>
  );
}

/**
 * Finished execution: a one-line "team scorecard". Doubles as the **stopped**
 * card (`stopped` — status=cancelled): same shape, "已停止" header and the
 * recovery row always offered (re-run).
 */
function CompletedCard({
  execution,
  stopped,
}: {
  execution: Execution;
  stopped?: boolean;
}) {
  const openGraph = useUIStore((s) => s.openGraph);
  const frames = useExecutionStore((s) => s.frames);
  const { completed, total } = execution.progress;
  const ms = elapsedMs(frames);
  const duration = ms > 0 ? formatDuration(ms) : "";

  // Partial failure: the CEO finished the turn (status=completed) but ≥1 worker
  // failed. That's not a crash, so we keep the scorecard yet surface an amber
  // notice + the shared recovery row, so the failure stays visible + actionable.
  const failedRuns = execution.runs.filter((s) => s.status === "failed");
  const failedRoles = failedRuns
    .map((s) => execution.agents.find((a) => a.id === s.agentId)?.role)
    .filter((r): r is string => Boolean(r));
  const failedRolesText =
    failedRoles.length > 0 ? `：${failedRoles.join("、")}` : "";
  const failureNotice = `${failedRuns.length} 个子任务失败${failedRolesText}，可重试，或调整指令后重发。`;
  const showRecovery = stopped || failedRuns.length > 0;

  // 回合成本 (§7.3A): the authoritative turn total is `message_end.cost` on the
  // last assistant message (captain + members), null until then. The run-sum
  // fallback for a stopped turn (no message_end) lives in `resolveTurnCost`.
  const turnCostTotal = useConversationStore((s) => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === "assistant")
        return s.messages[i].cost?.total ?? null;
    }
    return null;
  });
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const costTotal = resolveTurnCost(
    turnCostTotal,
    execution.runs.map((r) => r.cost?.total ?? 0),
  );
  // Only append the segment when there is real spend (0 / unknown shows nothing,
  // never「¥0.00」, §7.5); a stopped card prefixes「已花」.
  const costSegment =
    costTotal && costTotal > 0
      ? ` · ${stopped ? "已花 " : ""}${formatCost(costTotal, cnyPerUsd)}`
      : "";

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        {stopped ? (
          <Square size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <CheckCircle2 size={15} className="shrink-0 text-success" />
        )}
        <span className="flex-1 text-sm text-foreground">
          <span className="font-medium">{stopped ? "已停止" : "团队完成"}</span>
          <span className="text-muted-foreground">
            {` · ${execution.agents.length} 个 Agent · ${completed}/${total} 子任务${
              duration ? ` · 用时 ${duration}` : ""
            }${costSegment}`}
          </span>
        </span>
        <IconButton
          icon={<Workflow size={15} />}
          title="查看协作图"
          onClick={openGraph}
        />
        <TaskMenu execution={execution} />
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

      <TeamDetailEntry agentCount={execution.agents.length} />
    </div>
  );
}

/**
 * Shared failure-recovery row: 重试 / 调整指令 (inline edit) / 放弃. Reused by the
 * turn-crash {@link FailureCard} and the partial-failure {@link CompletedCard} so
 * both surface the same actions. Owns its own inline-edit state; every action
 * re-runs the turn from the last user message (whole-turn retry).
 */
function RecoveryActions({ abandonLabel = "放弃" }: { abandonLabel?: string }) {
  const isGenerating = useConversationStore((s) => s.isGenerating);
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

  const onAbandon = () => useExecutionStore.getState().clearExecution();

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
          <ActionButton
            icon={<X size={13} />}
            label="取消"
            onClick={() => setEditing(false)}
          />
          <ActionButton
            icon={<Check size={13} />}
            label="调整后重发"
            primary
            disabled={!draft.trim()}
            onClick={onAdjustSubmit}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ActionButton
        icon={<RotateCw size={13} />}
        label="重试"
        primary
        disabled={isGenerating}
        onClick={onRetry}
      />
      <ActionButton
        icon={<Pencil size={13} />}
        label="调整指令"
        disabled={isGenerating}
        onClick={onAdjust}
      />
      <ActionButton
        icon={<Ban size={13} />}
        label={abandonLabel}
        onClick={onAbandon}
      />
    </div>
  );
}

/** Failed execution (turn-level crash): failing agent/run + recovery actions. */
function FailureCard({ execution }: { execution: Execution }) {
  const openGraph = useUIStore((s) => s.openGraph);
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);

  const failedRun = execution.runs.find((s) => s.status === "failed") ?? null;
  const failedAgent = failedRun
    ? (execution.agents.find((a) => a.id === failedRun.agentId) ?? null)
    : null;

  // A crash gets no message_end, so surface what the team已花 from the worker runs
  // that completed before it failed (§7.3A). resolveTurnCost(null, …) returns null
  // when nothing real was spent, so we render「已花」only when there is.
  const spent = resolveTurnCost(
    null,
    execution.runs.map((r) => r.cost?.total ?? 0),
  );
  const spentText = spent != null ? formatCost(spent, cnyPerUsd) : null;

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="shrink-0 text-destructive" />
        <span className="flex-1 text-sm text-foreground">
          <span className="font-medium">任务失败</span>
          {spentText && (
            <span className="text-muted-foreground">{` · 已花 ${spentText}`}</span>
          )}
        </span>
        <IconButton
          icon={<Workflow size={15} />}
          title="查看协作图"
          onClick={openGraph}
        />
        <TaskMenu execution={execution} />
      </div>

      <div className="mt-2 rounded-lg bg-card/60 px-3 py-2 text-sm">
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

      <TeamDetailEntry agentCount={execution.agents.length} />
    </div>
  );
}

/** Labelled pill button used in the recovery action row. */
function ActionButton({
  icon,
  label,
  primary,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium disabled:opacity-40 ${
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
