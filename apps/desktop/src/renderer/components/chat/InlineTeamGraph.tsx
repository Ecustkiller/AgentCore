import { GraphView } from "@/components/graph/GraphView";
import { TeamGraphFullscreen } from "@/components/graph/TeamGraphFullscreen";
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
  type ExecutionJournal,
  ExecutionScopeContext,
  elapsedMs,
  useActiveExecField,
  useExecutionScope,
  useExecutionStore,
  useMessageExecution,
} from "@/stores/execution";
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

/**
 * The multi-agent turn's primary surface, embedded in the assistant message
 * above its answer: a compact status strip (lifecycle + cost + recovery) over
 * the live collaboration graph. It is the in-chat "team界面" that replaced the
 * old free-floating `TaskCard` + auto-opening detail panel + permanent graph
 * overlay — one graph, one place (前端UX设计.md §三).
 *
 * The strip can collapse the graph away (the answer stays right below), and the
 * canvas height adapts to team size so a small team does not float in a big box.
 *
 * Per-message (§9.3): keyed by the assistant message id, so live and reloaded
 * (historical) multi-agent turns render identically — the live turn streams into
 * the slot, a reloaded turn hydrates it from the persisted journal (`runs`), and
 * both project through the same fold. Node clicks drill into the passive
 * right-side panel; the maximize button opens the full-screen graph (replay).
 */
export function InlineTeamGraph({
  messageId,
  executionId,
  journal,
}: {
  messageId: string;
  executionId: string;
  journal?: ExecutionJournal;
}) {
  const [expanded, setExpanded] = useState(true);
  // false = closed; "view" = full-screen graph; "replay" = full-screen with the
  // timeline auto-playing (the inline card's 回放 entry).
  const [fullscreen, setFullscreen] = useState<false | "view" | "replay">(
    false,
  );

  // Reload path: rebuild this message's execution slot from its persisted
  // journal so the team graph replays on demand. Idempotent and a no-op for the
  // live turn (which already streamed into the slot + has no `journal`), so it is
  // safe on every mount.
  const hydrateFromJournal = useExecutionStore((s) => s.hydrateFromJournal);
  useEffect(() => {
    if (journal) hydrateFromJournal(messageId, journal);
  }, [journal, messageId, hydrateFromJournal]);

  // Project THIS message's slot (not a single live slot), so a historical turn
  // draws its own graph exactly like the live one.
  const execution = useMessageExecution(messageId);

  // Nothing to draw until the slot exists (live: first `run_plan`; reload: after
  // the hydrate effect commits) and only for a real team turn.
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
  // The default left-right flow stacks parallel workers vertically, so it needs
  // more height than the old top-down default to keep fitView from shrinking the
  // graph in the narrow message column — hence the taller base/step and ceiling.
  const graphHeight = Math.min(
    540,
    Math.max(260, 180 + execution.runs.length * 90),
  );

  // Scope every descendant graph hook (status strip, canvas, timeline, node
  // detail — even through the full-screen portal) to this message's slot, so
  // each graph reads/writes the right turn through one keyed path.
  return (
    <ExecutionScopeContext.Provider value={messageId}>
      <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
        <StatusStrip
          execution={execution}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          onMaximize={() => setFullscreen("view")}
          onReplay={() => setFullscreen("replay")}
        />
        {expanded && (
          <GraphArea
            execution={execution}
            messageId={messageId}
            height={graphHeight}
          />
        )}
        {fullscreen && (
          <TeamGraphFullscreen
            autoplay={fullscreen === "replay"}
            onClose={() => setFullscreen(false)}
          />
        )}
      </div>
    </ExecutionScopeContext.Provider>
  );
}

/** The embedded graph + its drill-down wiring. Node clicks open the passive
 * right-side run detail for this message; the strip's maximize button owns
 * full-screen. */
function GraphArea({
  execution,
  messageId,
  height,
}: {
  execution: Execution;
  messageId: string;
  height: number;
}) {
  const showRunDetail = useDetailPanelStore((s) => s.showRunDetail);

  const onNodeSelect = (runId: string) => {
    const run = execution.runs.find((r) => r.id === runId);
    const role = execution.agents.find((a) => a.id === run?.agentId)?.role;
    showRunDetail(messageId, runId, role);
  };

  return (
    <div className="w-full border-t border-border" style={{ height }}>
      <GraphView embedded onNodeSelect={onNodeSelect} />
    </div>
  );
}

/** Props every lifecycle strip shares: the projection + the strip controls
 * (collapse, full-screen, replay). */
interface StripProps {
  execution: Execution;
  expanded: boolean;
  onToggle: () => void;
  onMaximize: () => void;
  onReplay: () => void;
}

/** Lifecycle-specific header row above the graph. */
function StatusStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
}: StripProps) {
  const ctrl = { expanded, onToggle, onMaximize, onReplay };
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

/** Trailing controls shared by every strip: stop (while running), replay (once
 * finished), collapse the graph, and full-screen. Whole-turn re-runs live with
 * the message ("重新生成") and the failure card ("重试"), so the graph itself
 * carries no re-run control. */
function StripControls({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
}: StripProps) {
  const isRunning = execution.status === "running";
  const canReplay =
    execution.status === "completed" || execution.status === "cancelled";
  return (
    <>
      {isRunning && (
        <IconButton
          icon={<Square size={15} />}
          title="停止任务"
          onClick={() => useConversationStore.getState().stopGeneration()}
        />
      )}
      {canReplay && (
        <IconButton
          icon={<Play size={15} />}
          title="回放协作过程"
          onClick={onReplay}
        />
      )}
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
    </>
  );
}

/** Active execution: live progress bar in the strip. */
function RunningStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
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
  onReplay,
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

/** Failed execution (turn-level crash): failing agent/run + recovery actions. */
function FailureStrip({
  execution,
  expanded,
  onToggle,
  onMaximize,
  onReplay,
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
 * Shared failure-recovery row: 重试 / 调整指令 (inline edit) / 放弃. Reused by the
 * turn-crash {@link FailureStrip} and the partial-failure {@link CompletedStrip}
 * so both surface the same actions. Owns its inline-edit state; every action
 * re-runs the turn from the last user message (whole-turn retry).
 */
function RecoveryActions({ abandonLabel = "放弃" }: { abandonLabel?: string }) {
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
