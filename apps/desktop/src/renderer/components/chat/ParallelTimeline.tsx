import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import type {
  BatchMetricsSnapshot,
  Execution,
  NodeTiming,
} from "@/stores/execution";

/**
 * 多任务并行图 · 并行甘特 (前端UX设计.md §6.5) — the temporal truth the collaboration
 * DAG can't show: every worker run on a real time axis (offsets from the scheduler's wall
 * start). Overlap = true concurrency; gap before a bar = `width` cap serialization;
 * longest bar = critical path.
 *
 * Embedded in {@link import("../graph/GraphView")} as timeline layout mode (toolbar
 * 时间轴) or the standalone page wrapper below. Data rides `batch_metrics` SSE → {@link BatchMetricsSnapshot.timeline}.
 */
export function ParallelTimeline({ execution }: { execution: Execution }) {
  const batches = execution.batches.filter((b) => b.timeline.length > 0);
  if (batches.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">并行时间线</h2>
        <p className="text-xs text-muted-foreground">
          每条是一个队员的执行区间，横轴为真实时间。
          <span className="text-foreground">重叠</span>
          ＝真并行，<span className="text-foreground">空档</span>
          ＝并发上限让它排队，
          <span className="text-foreground">最长条</span>＝关键路径。
        </p>
      </header>
      <ParallelGantt execution={execution} />
    </div>
  );
}

/** Gantt tracks — reusable in GraphView bottom bar (`embedded`) or full-page header wrapper. */
export function ParallelGantt({
  execution,
  embedded = false,
  highlightRunId = null,
  onRunHover,
}: {
  execution: Execution;
  /** Compact strip under the collaboration graph (no page header). */
  embedded?: boolean;
  highlightRunId?: string | null;
  onRunHover?: (runId: string | null) => void;
}) {
  const batches = execution.batches.filter((b) => b.timeline.length > 0);
  if (batches.length === 0) return null;

  return (
    <div className={embedded ? "flex flex-col gap-2" : "flex flex-col gap-6"}>
      {batches.map((batch, i) => (
        <BatchTrack
          key={batch.timeline[0].runId}
          batch={batch}
          label={batches.length > 1 ? `批次 ${i + 1}` : null}
          execution={execution}
          embedded={embedded}
          highlightRunId={highlightRunId}
          onRunHover={onRunHover}
        />
      ))}
    </div>
  );
}

/** Whether a turn has enough parallel-execution data for the graph gantt strip: ≥2 dispatched
 * worker runs across scheduler segments (a single-worker one-bar timeline is trivial). */
export function hasParallelTimeline(execution: Execution): boolean {
  return execution.batches.reduce((n, b) => n + b.timeline.length, 0) >= 2;
}

/** One-line scheduling summary for the graph toolbar chip. */
export function parallelTimelineMetricsSummary(execution: Execution): string | null {
  const batches = execution.batches.filter((b) => b.timeline.length > 0);
  if (batches.length === 0) return null;
  const peak = Math.max(...batches.map((b) => b.peakRunning));
  const wallMs = batches.reduce((s, b) => s + b.wallMs, 0);
  const starved = batches.reduce((s, b) => s + b.slotStarved, 0);
  const parts = [`峰值 ${peak}`, fmtMs(wallMs)];
  if (starved > 0) parts.splice(1, 0, `串行 ${starved}`);
  if (batches.length > 1) parts.unshift(`${batches.length} 批次`);
  return parts.join(" · ");
}

const ROW_HEIGHT = 28;
const ROW_HEIGHT_COMPACT = 22;
const MIN_BAR_PCT = 1.5;

function BatchTrack({
  batch,
  label,
  execution,
  embedded,
  highlightRunId,
  onRunHover,
}: {
  batch: BatchMetricsSnapshot;
  label: string | null;
  execution: Execution;
  embedded: boolean;
  highlightRunId: string | null;
  onRunHover?: (runId: string | null) => void;
}) {
  const span = Math.max(batch.wallMs, ...batch.timeline.map((n) => n.endMs), 1);
  const rows = [...batch.timeline].sort((a, b) => a.startMs - b.startMs);
  const rowH = embedded ? ROW_HEIGHT_COMPACT : ROW_HEIGHT;

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">
          {embedded ? (label ?? "真实时间轴") : (label ?? "调度")}
        </span>
        <span className="text-xs text-muted-foreground">
          并发峰值 {batch.peakRunning} · 总时长 {fmtMs(batch.wallMs)}
          {batch.slotStarved > 0 && (
            <span className="text-foreground">
              {" "}
              · 上限 {batch.width} 串行化
            </span>
          )}
        </span>
      </div>
      <div
        className={
          embedded
            ? "relative rounded-lg border border-border bg-muted/20 p-1.5"
            : "relative rounded-lg border border-border bg-muted/20 p-2"
        }
      >
        <div className="pointer-events-none absolute inset-1.5" aria-hidden>
          {[25, 50, 75].map((p) => (
            <div
              key={p}
              className="absolute top-0 bottom-0 border-l border-border/40"
              style={{ left: `${p}%` }}
            />
          ))}
        </div>
        <div className="relative flex flex-col gap-0.5">
          {rows.map((n) => (
            <TimelineRow
              key={n.runId}
              node={n}
              span={span}
              rowHeight={rowH}
              compact={embedded}
              highlighted={highlightRunId === n.runId}
              onHover={onRunHover}
              {...resolveRole(execution, n.runId)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function TimelineRow({
  node,
  span,
  rowHeight,
  compact,
  highlighted,
  onHover,
  role,
  task,
}: {
  node: NodeTiming;
  span: number;
  rowHeight: number;
  compact: boolean;
  highlighted: boolean;
  onHover?: (runId: string | null) => void;
  role: string;
  task: string | null;
}) {
  const leftPct = (node.startMs / span) * 100;
  const widthPct = Math.max(
    ((node.endMs - node.startMs) / span) * 100,
    MIN_BAR_PCT,
  );
  const failed = node.outcome === "failed";
  const color = agentColorVar(role);
  const dur = fmtMs(node.endMs - node.startMs);

  return (
    <div
      className="flex items-center gap-1.5"
      style={{ height: rowHeight }}
      onMouseEnter={() => onHover?.(node.runId)}
      onMouseLeave={() => onHover?.(null)}
    >
      {!compact && (
        <div
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ backgroundColor: color }}
          aria-hidden
        >
          {agentGlyph(role)}
        </div>
      )}
      <span
        className={
          compact
            ? "w-16 shrink-0 truncate text-xs text-foreground"
            : "w-24 shrink-0 truncate text-xs text-foreground"
        }
        title={task ?? role}
      >
        {role}
      </span>
      <div className="relative h-4 flex-1">
        <div
          className={`absolute top-0 bottom-0 flex cursor-default items-center justify-end rounded-md px-1 transition-opacity ${
            failed ? "ring-1 ring-destructive" : ""
          } ${highlighted ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""}`}
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            backgroundColor: color,
            opacity: failed ? 0.65 : highlighted ? 1 : 0.9,
          }}
          title={`${role} · ${fmtMs(node.startMs)}→${fmtMs(node.endMs)} · 用时 ${dur}${
            failed ? " · 失败" : ""
          }`}
        >
          <span className="truncate text-xs font-medium text-white/95">{dur}</span>
        </div>
      </div>
    </div>
  );
}

function resolveRole(
  execution: Execution,
  runId: string,
): { role: string; task: string | null } {
  const run = execution.runs.find((r) => r.id === runId);
  const role = execution.agents.find((a) => a.id === run?.agentId)?.role;
  return { role: role ?? run?.task ?? runId, task: run?.task ?? null };
}

/** Compact ms → 「N毫秒」/「N.N秒」for the bar labels (sub-second stays in ms so a fast
 * tool call doesn't collapse to 0.0秒). */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
