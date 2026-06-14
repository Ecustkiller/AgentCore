import { GraphView } from "@/components/graph/GraphView";
import { TeamGraphFullscreen } from "@/components/graph/TeamGraphFullscreen";
import { copyText } from "@/lib/clipboard";
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
import { useDetailPanelStore } from "@/stores/detailPanel";
import {
  type Execution,
  elapsedMs,
  useActiveExecField,
  useExecutionStore,
  useProjectedExecution,
} from "@/stores/execution";
import { useUsageStore } from "@/stores/usage";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The multi-agent turn's primary surface, embedded in the assistant message
 * above its answer: a compact status strip (lifecycle + cost + recovery) over
 * the live collaboration graph. It is the in-chat "team界面" that replaced the
 * old free-floating `TaskCard` + auto-opening detail panel + permanent graph
 * overlay — one graph, one place (统一团队展示设计草案).
 *
 * The strip can collapse the graph away (the answer stays right below), and the
 * canvas height adapts to team size so a small team does not float in a big box.
 *
 * Live-only for now (P0): it reads the single live execution store, so it renders
 * only on the message whose turn is the one currently projected; reloaded
 * (historical) multi-agent turns fall back to a plain bubble until per-message
 * runs land (P2). Node clicks drill into the passive right-side panel; the
 * maximize button opens the temporary full-screen graph (timeline replay).
 */
export function InlineTeamGraph({ executionId }: { executionId: string }) {
  const execution = useProjectedExecution();
  const [expanded, setExpanded] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // Gate on the live turn: a different (historical) message carries an
  // executionId that does not match the one projection in the store, and a
  // single-agent turn has no team to draw.
  if (
    !execution ||
    execution.id !== executionId ||
    execution.planType === "single_agent"
  ) {
    return null;
  }

  // Adaptive height: reserve only as much canvas as the team needs (a 2-agent
  // team would otherwise float in a half-empty box), clamped so a big DAG still
  // fits the message column. React Flow's fitView fills whatever height we give.
  const graphHeight = Math.min(
    460,
    Math.max(240, 150 + execution.runs.length * 78),
  );

  // Stable wrapper so the entrance animation plays once when the block first
  // mounts on `run_plan`; inner status swaps (running→done) reuse this element.
  return (
    <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
      <StatusStrip
        execution={execution}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        onMaximize={() => setFullscreen(true)}
      />
      {expanded && <GraphArea execution={execution} height={graphHeight} />}
      {fullscreen && (
        <TeamGraphFullscreen onClose={() => setFullscreen(false)} />
      )}
    </div>
  );
}

/** The embedded live graph + its drill-down wiring. Node clicks open the passive
 * right-side run detail; the strip's maximize button owns full-screen. */
function GraphArea({
  execution,
  height,
}: {
  execution: Execution;
  height: number;
}) {
  const showRunDetail = useDetailPanelStore((s) => s.showRunDetail);

  const onNodeSelect = (runId: string) => {
    const run = execution.runs.find((r) => r.id === runId);
    const role = execution.agents.find((a) => a.id === run?.agentId)?.role;
    showRunDetail(runId, role);
  };

  return (
    <div className="w-full border-t border-border" style={{ height }}>
      <GraphView embedded onNodeSelect={onNodeSelect} />
    </div>
  );
}

/** Props every lifecycle strip shares: the projection + the collapse toggle. */
interface StripProps {
  execution: Execution;
  expanded: boolean;
  onToggle: () => void;
  onMaximize: () => void;
}

/** Lifecycle-specific header row above the graph. */
function StatusStrip({ execution, expanded, onToggle, onMaximize }: StripProps) {
  const ctrl = { expanded, onToggle, onMaximize };
  switch (execution.status) {
    case "completed":
      return <CompletedStrip execution={execution} {...ctrl} />;
    case "cancelled":
      return <CompletedStrip execution={execution} stopped {...ctrl} />;
    case "failed":
      return <FailureStrip execution={execution} {...ctrl} />;
    default:
      return <RunningStrip execution={execution} {...ctrl} />;
  }
}

/** Circular icon button used in the strip's trailing controls. */
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

/** Trailing controls shared by every strip: collapse the graph, maximize it,
 * and the overflow menu. */
function StripControls({
  execution,
  expanded,
  onToggle,
  onMaximize,
}: StripProps) {
  return (
    <>
      <IconButton
        icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        title={expanded ? "收起协作图" : "展开协作图"}
        onClick={onToggle}
      />
      <IconButton
        icon={<Maximize2 size={15} />}
        title="全屏查看协作图"
        onClick={onMaximize}
      />
      <TaskMenu execution={execution} />
    </>
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

/** Active execution: live progress bar in the strip. */
function RunningStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
}: StripProps) {
  const { completed, total } = execution.progress;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <Loader2 size={15} className="shrink-0 animate-spin text-primary" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {execution.taskSummary}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {completed}/{total}
        </span>
        <StripControls
          execution={execution}
          expanded={expanded}
          onToggle={onToggle}
          onMaximize={onMaximize}
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

/**
 * Finished execution: a one-line "team scorecard". Doubles as the **stopped**
 * strip (`stopped` — status=cancelled): same shape, "已停止" header and the
 * recovery row always offered (re-run).
 */
function CompletedStrip({
  execution,
  stopped,
  expanded,
  onToggle,
  onMaximize,
}: StripProps & { stopped?: boolean }) {
  const frames = useActiveExecField((rt) => rt.frames);
  const { completed, total } = execution.progress;
  const ms = elapsedMs(frames);
  const duration = ms > 0 ? formatDuration(ms) : "";

  // Partial failure: the CEO finished the turn (status=completed) but ≥1 worker
  // failed. Not a crash, so keep the scorecard yet surface an amber notice + the
  // shared recovery row, so the failure stays visible + actionable.
  const failedRuns = execution.runs.filter((s) => s.status === "failed");
  const failedRoles = failedRuns
    .map((s) => execution.agents.find((a) => a.id === s.agentId)?.role)
    .filter((r): r is string => Boolean(r));
  const failedRolesText =
    failedRoles.length > 0 ? `：${failedRoles.join("、")}` : "";
  const failureNotice = `${failedRuns.length} 个子任务失败${failedRolesText}，可重试，或调整指令后重发。`;
  const showRecovery = stopped || failedRuns.length > 0;

  // 回合成本 (§7.3A): authoritative turn total is `message_end.cost` on the last
  // assistant message (captain + members), null until then; the run-sum fallback
  // for a stopped turn (no message_end) lives in `resolveTurnCost`.
  const turnCostTotal = useConversationStore((s) =>
    selectLastAssistantCostTotal(activeRuntime(s).messages),
  );
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const costTotal = resolveTurnCost(
    turnCostTotal,
    execution.runs.map((r) => r.cost?.total ?? 0),
  );
  // Append only on real spend (0 / unknown shows nothing, never「¥0.00」, §7.5);
  // a stopped strip prefixes「已花」.
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
          <span className="font-medium">{stopped ? "已停止" : "团队完成"}</span>
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

/** Failed execution (turn-level crash): failing agent/run + recovery actions. */
function FailureStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
}: StripProps) {
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
 * Shared failure-recovery row: 重试 / 调整指令 (inline edit) / 放弃. Reused by the
 * turn-crash {@link FailureStrip} and the partial-failure {@link CompletedStrip}
 * so both surface the same actions. Owns its inline-edit state; every action
 * re-runs the turn from the last user message (whole-turn retry).
 */
function RecoveryActions({ abandonLabel = "放弃" }: { abandonLabel?: string }) {
  const isGenerating = useActiveGenerating();
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
