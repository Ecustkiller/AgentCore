import { agentColorVar, agentGlyph } from "@/lib/agentIdentity";
import type {
  BatchMetricsSnapshot,
  Execution,
  NodeTiming,
} from "@/stores/execution";

/**
 * 多任务并行图 · 并行时间线 (前端UX设计.md §6.5) — the one view that shows the *temporal*
 * truth the collaboration DAG can't. The graph draws **dependency** structure; this lays
 * every worker run on a real time axis (offsets from the scheduler's wall start), so the
 * user SEES: overlapping bars = nodes that truly ran at the same time, a gap before a bar =
 * the `width` 并发上限 made a ready node wait for a free slot (串行化), and the longest bar
 * = the turn's critical path. Bars carry the worker's identity color ({@link agentColorVar},
 * same as the graph), a failed run gets a destructive ring (identity vs status decoupled,
 * color-tokens.mdc).
 *
 * Data is the scheduler's own per-node dispatch/finish marks, surfaced verbatim through the
 * `batch_metrics` SSE → {@link BatchMetricsSnapshot.timeline} fold (the same plumbing the
 * 诊断 aggregates ride). Most turns hold one segment; a checkpoint / scope yield + resume
 * appends another, each rendered as its own「批次 N」track (own t0 / wall).
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
      {batches.map((batch, i) => (
        // Keyed by the segment's first dispatched run — unique across segments (a node
        // runs in exactly one scheduler segment; a resume seeds prior nodes as completed
        // and omits them here) and stable, so no array-index key. `i` is the display 批次 N.
        <BatchTrack
          key={batch.timeline[0].runId}
          batch={batch}
          label={batches.length > 1 ? `批次 ${i + 1}` : null}
          execution={execution}
        />
      ))}
    </div>
  );
}

/** Whether a turn has enough parallel-execution data to warrant the 并行时间线 view: at
 * least two dispatched worker runs across its scheduler segments (a single-worker turn's
 * one-bar timeline is trivial). Gates the canvas 放大态 view switcher. */
export function hasParallelTimeline(execution: Execution): boolean {
  return execution.batches.reduce((n, b) => n + b.timeline.length, 0) >= 2;
}

const ROW_HEIGHT = 28;
const MIN_BAR_PCT = 1.5;

function BatchTrack({
  batch,
  label,
  execution,
}: {
  batch: BatchMetricsSnapshot;
  label: string | null;
  execution: Execution;
}) {
  // The axis spans the segment's wall time; fall back to the latest finish so a bar never
  // overflows if wallMs is rounded short, and guard the divisor against a zero-length run.
  const span = Math.max(batch.wallMs, ...batch.timeline.map((n) => n.endMs), 1);
  const rows = [...batch.timeline].sort((a, b) => a.startMs - b.startMs);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">
          {label ?? "调度"}
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
      <div className="relative rounded-lg border border-border bg-muted/20 p-2">
        {/* quarter gridlines — a light time scale behind the bars */}
        <div className="pointer-events-none absolute inset-2" aria-hidden>
          {[25, 50, 75].map((p) => (
            <div
              key={p}
              className="absolute top-0 bottom-0 border-l border-border/40"
              style={{ left: `${p}%` }}
            />
          ))}
        </div>
        <div className="relative flex flex-col gap-1">
          {rows.map((n) => (
            <TimelineRow
              key={n.runId}
              node={n}
              span={span}
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
  role,
  task,
}: {
  node: NodeTiming;
  span: number;
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
    <div className="flex items-center gap-2" style={{ height: ROW_HEIGHT }}>
      <div
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: color }}
        aria-hidden
      >
        {agentGlyph(role)}
      </div>
      <span
        className="w-24 shrink-0 truncate text-xs text-foreground"
        title={task ?? role}
      >
        {role}
      </span>
      <div className="relative h-5 flex-1">
        <div
          className={`absolute top-0 bottom-0 flex items-center justify-end rounded-md px-1.5 ${
            failed ? "ring-1 ring-destructive" : ""
          }`}
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            backgroundColor: color,
            opacity: failed ? 0.65 : 0.9,
          }}
          title={`${role} · ${fmtMs(node.startMs)}→${fmtMs(node.endMs)} · 用时 ${dur}${
            failed ? " · 失败" : ""
          }`}
        >
          <span className="truncate text-[10px] font-medium text-white/95">
            {dur}
          </span>
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
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
