// @vitest-environment jsdom
/**
 * Render test for 并行时间线 (多任务并行图, 前端UX设计.md §6.5).
 *
 * The view lives in the canvas 放大态 (a ReactFlow-heavy surface the shoot harness doesn't
 * drive into), so this asserts the gantt DOM directly: a bar per dispatched node with its
 * role label + duration, the 并发峰值/总时长 header, the 串行化 hint when the width cap bit,
 * a destructive ring on a failed bar, 批次 numbering for multi-segment turns — plus the
 * `hasParallelTimeline` gate the switcher keys off.
 */

import type { BatchMetricsSnapshot, Execution } from "@/stores/execution";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ParallelGantt, ParallelTimeline, hasParallelTimeline } from "../ParallelTimeline";

afterEach(cleanup);

const metrics = (
  over: Partial<BatchMetricsSnapshot>,
): BatchMetricsSnapshot => ({
  nodes: 2,
  width: 8,
  peakRunning: 2,
  wallMs: 2000,
  busyMs: 3000,
  slotStarved: 0,
  completed: 2,
  failed: 0,
  skipped: 0,
  bindBoundaries: 0,
  scopeBoundaries: 0,
  checkpointBoundaries: 0,
  escalations: 0,
  scopeEscalations: 0,
  timeline: [],
  ...over,
});

/** Minimal Execution fixture — ParallelTimeline only reads batches + runs(id→agentId) +
 * agents(id→role), so the rest is cast away rather than hand-built. */
function exec(batches: BatchMetricsSnapshot[]): Execution {
  return {
    id: "e1",
    planType: "multi_agent",
    taskSummary: "t",
    status: "completed",
    agents: [
      { id: "ag1", role: "研究员" },
      { id: "ag2", role: "工程师" },
    ],
    runs: [
      { id: "w1", agentId: "ag1", task: "调研" },
      { id: "w2", agentId: "ag2", task: "实现" },
    ],
    progress: { completed: 2, total: 2 },
    batches,
    debate: null,
    debateRounds: [],
  } as unknown as Execution;
}

describe("ParallelTimeline (并行时间线)", () => {
  it("renders a bar per node with role label + duration and a concurrency header", () => {
    const { container } = render(
      ParallelTimelineEl([
        metrics({
          peakRunning: 2,
          wallMs: 2000,
          timeline: [
            { runId: "w1", startMs: 0, endMs: 1800, outcome: "completed" },
            { runId: "w2", startMs: 5, endMs: 2000, outcome: "completed" },
          ],
        }),
      ]),
    );
    expect(screen.getByText("并行时间线")).toBeTruthy();
    expect(screen.getByText("研究员")).toBeTruthy();
    expect(screen.getByText("工程师")).toBeTruthy();
    expect(container.textContent).toContain("并发峰值 2");
    expect(container.textContent).toContain("总时长 2.0s");
    // 1800ms → 1.8s, 1995ms → 2.0s (bar duration labels).
    expect(container.textContent).toContain("1.8s");
  });

  it("surfaces the width cap as 串行化 and rings a failed bar", () => {
    const { container } = render(
      ParallelTimelineEl([
        metrics({
          width: 1,
          peakRunning: 1,
          slotStarved: 3,
          failed: 1,
          timeline: [
            { runId: "w1", startMs: 0, endMs: 1000, outcome: "completed" },
            { runId: "w2", startMs: 1000, endMs: 1500, outcome: "failed" },
          ],
        }),
      ]),
    );
    expect(container.textContent).toContain("上限 1 串行化");
    expect(container.querySelector(".ring-destructive")).toBeTruthy();
  });

  it("numbers each scheduler segment when a turn has multiple batches", () => {
    const { container } = render(
      ParallelTimelineEl([
        metrics({
          timeline: [
            { runId: "w1", startMs: 0, endMs: 500, outcome: "completed" },
          ],
        }),
        metrics({
          timeline: [
            { runId: "w2", startMs: 0, endMs: 700, outcome: "completed" },
          ],
        }),
      ]),
    );
    expect(container.textContent).toContain("批次 1");
    expect(container.textContent).toContain("批次 2");
  });

  it("renders nothing when no batch carries timing", () => {
    const { container } = render(
      ParallelTimelineEl([metrics({ timeline: [] })]),
    );
    expect(container.textContent).toBe("");
  });
});

describe("ParallelGantt (embedded graph strip)", () => {
  it("renders compact tracks without the full-page header", () => {
    const { container } = render(
      <ParallelGantt
        execution={exec([
          metrics({
            timeline: [
              { runId: "w1", startMs: 0, endMs: 1800, outcome: "completed" },
              { runId: "w2", startMs: 5, endMs: 2000, outcome: "completed" },
            ],
          }),
        ])}
        embedded
      />,
    );
    expect(screen.queryByText("并行时间线")).toBeNull();
    expect(screen.getByText("真实时间轴")).toBeTruthy();
    expect(screen.getByText("研究员")).toBeTruthy();
    expect(container.textContent).toContain("1.8s");
  });
});

describe("hasParallelTimeline (gate)", () => {
  it("is true with ≥2 dispatched nodes (within or across segments)", () => {
    expect(
      hasParallelTimeline(
        exec([
          metrics({
            timeline: [
              { runId: "w1", startMs: 0, endMs: 1, outcome: "completed" },
              { runId: "w2", startMs: 0, endMs: 1, outcome: "completed" },
            ],
          }),
        ]),
      ),
    ).toBe(true);
    expect(
      hasParallelTimeline(
        exec([
          metrics({
            timeline: [
              { runId: "w1", startMs: 0, endMs: 1, outcome: "completed" },
            ],
          }),
          metrics({
            timeline: [
              { runId: "w2", startMs: 0, endMs: 1, outcome: "completed" },
            ],
          }),
        ]),
      ),
    ).toBe(true);
  });

  it("is false for a single-node or empty timeline (nothing parallel to show)", () => {
    expect(
      hasParallelTimeline(
        exec([
          metrics({
            timeline: [
              { runId: "w1", startMs: 0, endMs: 1, outcome: "completed" },
            ],
          }),
        ]),
      ),
    ).toBe(false);
    expect(hasParallelTimeline(exec([]))).toBe(false);
  });
});

/** Build the element from a batches array via the same minimal fixture. */
function ParallelTimelineEl(batches: BatchMetricsSnapshot[]) {
  return <ParallelTimeline execution={exec(batches)} />;
}
