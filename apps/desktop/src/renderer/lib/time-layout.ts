/** Time-axis layout for the collaboration graph (第三种布局 · 时间轴). */

import type { BatchMetricsSnapshot, Execution } from "@/stores/execution";

export const TIMELINE_ROW_HEIGHT = 64;
export const TIMELINE_ROW_GAP = 10;
export const TIMELINE_PAD_LEFT = 32;
export const TIMELINE_PAD_TOP = 40;
export const TIMELINE_PAD_RIGHT = 48;
export const TIMELINE_PAD_BOTTOM = 32;
export const TIMELINE_INNER_WIDTH = 720;
export const TIMELINE_MIN_BAR_WIDTH = 56;
export const TIMELINE_ENDPOINT_WIDTH = 160;
export const TIMELINE_ENDPOINT_HEIGHT = 72;
export const TIMELINE_CAPTAIN_GAP = 80;

export interface TimeLayoutNodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TimeLayoutResult {
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, { width: number; height: number }>;
  width: number;
  height: number;
  /** Vertical batch separators (between scheduler segments). */
  batchDividers: { x: number; label: string }[];
}

interface OffsetTiming {
  runId: string;
  startMs: number;
  endMs: number;
  outcome: string;
  batchIndex: number;
}

/** Stitch multi-segment `batches[]` onto one continuous ms axis. */
export function concatBatchTimelines(batches: BatchMetricsSnapshot[]): {
  timings: OffsetTiming[];
  totalSpanMs: number;
} {
  let offset = 0;
  const timings: OffsetTiming[] = [];
  const nonEmpty = batches.filter((b) => b.timeline.length > 0);
  for (let bi = 0; bi < nonEmpty.length; bi++) {
    const batch = nonEmpty[bi];
    for (const n of batch.timeline) {
      timings.push({
        runId: n.runId,
        startMs: n.startMs + offset,
        endMs: n.endMs + offset,
        outcome: n.outcome,
        batchIndex: bi,
      });
    }
    offset += batch.wallMs;
  }
  const totalSpanMs = Math.max(offset, ...timings.map((t) => t.endMs), 1);
  return { timings, totalSpanMs };
}

/**
 * Lay worker runs on a real time axis (X = wall ms, Y = one row per dispatched run).
 * Bookends pin outside the worker band: input left, captain right of the last bar.
 */
export function computeTimeLayout(
  execution: Execution,
  nodeIds: string[],
  inputId: string,
  captainId: string | null,
): TimeLayoutResult {
  const { timings, totalSpanMs } = concatBatchTimelines(execution.batches);
  const scale = TIMELINE_INNER_WIDTH / totalSpanMs;

  const positions: Record<string, { x: number; y: number }> = {};
  const sizes: Record<string, { width: number; height: number }> = {};
  const batchDividers: { x: number; label: string }[] = [];

  const toX = (ms: number) => TIMELINE_PAD_LEFT + ms * scale;
  const toWidth = (startMs: number, endMs: number) =>
    Math.max(TIMELINE_MIN_BAR_WIDTH, (endMs - startMs) * scale);

  const sorted = [...timings].sort(
    (a, b) => a.startMs - b.startMs || a.runId.localeCompare(b.runId),
  );
  const rowByRunId = new Map<string, number>();
  let rowCount = 0;
  for (const t of sorted) {
    if (!rowByRunId.has(t.runId)) {
      rowByRunId.set(t.runId, rowCount++);
    }
  }

  const workerAreaHeight =
    rowCount > 0
      ? rowCount * TIMELINE_ROW_HEIGHT + (rowCount - 1) * TIMELINE_ROW_GAP
      : TIMELINE_ROW_HEIGHT;

  for (const t of sorted) {
    const row = rowByRunId.get(t.runId);
    if (row === undefined) continue;
    const y = TIMELINE_PAD_TOP + row * (TIMELINE_ROW_HEIGHT + TIMELINE_ROW_GAP);
    positions[t.runId] = { x: toX(t.startMs), y };
    sizes[t.runId] = {
      width: toWidth(t.startMs, t.endMs),
      height: TIMELINE_ROW_HEIGHT,
    };
  }

  let maxWorkerEndX = TIMELINE_PAD_LEFT;
  for (const t of timings) {
    maxWorkerEndX = Math.max(maxWorkerEndX, toX(t.endMs));
  }

  const nonEmpty = execution.batches.filter((b) => b.timeline.length > 0);
  let batchOffset = 0;
  for (let i = 0; i < nonEmpty.length - 1; i++) {
    batchOffset += nonEmpty[i].wallMs;
    batchDividers.push({
      x: toX(batchOffset),
      label: `批次 ${i + 2}`,
    });
  }

  const endpointY =
    TIMELINE_PAD_TOP +
    Math.max(0, (workerAreaHeight - TIMELINE_ENDPOINT_HEIGHT) / 2);

  if (nodeIds.includes(inputId)) {
    positions[inputId] = {
      x: Math.max(8, TIMELINE_PAD_LEFT - TIMELINE_ENDPOINT_WIDTH - 24),
      y: endpointY,
    };
    sizes[inputId] = {
      width: TIMELINE_ENDPOINT_WIDTH,
      height: TIMELINE_ENDPOINT_HEIGHT,
    };
  }

  if (captainId && nodeIds.includes(captainId)) {
    const captainRun = execution.runs.find((r) => r.id === captainId);
    const captainDur = captainRun?.durationMs ?? 500;
    const capW = Math.max(TIMELINE_ENDPOINT_WIDTH, toWidth(0, captainDur));
    positions[captainId] = {
      x: maxWorkerEndX + TIMELINE_CAPTAIN_GAP,
      y: endpointY,
    };
    sizes[captainId] = {
      width: capW,
      height: TIMELINE_ENDPOINT_HEIGHT,
    };
  }

  const maxX = Math.max(
    ...Object.entries(positions).map(
      ([id, p]) => p.x + (sizes[id]?.width ?? TIMELINE_MIN_BAR_WIDTH),
    ),
    TIMELINE_PAD_LEFT + TIMELINE_INNER_WIDTH,
  );

  return {
    positions,
    sizes,
    width: maxX + TIMELINE_PAD_RIGHT,
    height: TIMELINE_PAD_TOP + workerAreaHeight + TIMELINE_PAD_BOTTOM,
    batchDividers,
  };
}
