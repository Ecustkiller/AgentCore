// @vitest-environment node

import { INPUT_ID } from "@/components/graph/constants";
import type { BatchMetricsSnapshot, Execution } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import {
  TIMELINE_CAPTAIN_GAP,
  TIMELINE_PAD_LEFT,
  concatBatchTimelines,
  computeTimeLayout,
} from "../time-layout";

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
      { id: "w1", agentId: "ag1", task: "调研", kind: "worker" },
      { id: "w2", agentId: "ag2", task: "实现", kind: "worker" },
      { id: "cap", agentId: "ceo", kind: "captain", durationMs: 400 },
    ],
    progress: { completed: 2, total: 2 },
    batches,
    debate: null,
    debateRounds: [],
  } as unknown as Execution;
}

describe("concatBatchTimelines", () => {
  it("offsets a second batch after the first wallMs", () => {
    const { timings, totalSpanMs } = concatBatchTimelines([
      metrics({
        wallMs: 1000,
        timeline: [{ runId: "w1", startMs: 0, endMs: 900, outcome: "completed" }],
      }),
      metrics({
        wallMs: 500,
        timeline: [{ runId: "w2", startMs: 0, endMs: 400, outcome: "completed" }],
      }),
    ]);
    expect(timings).toHaveLength(2);
    expect(timings[0].startMs).toBe(0);
    expect(timings[1].startMs).toBe(1000);
    expect(timings[1].endMs).toBe(1400);
    expect(totalSpanMs).toBe(1500);
  });
});

describe("computeTimeLayout", () => {
  it("places overlapping workers on separate rows with proportional widths", () => {
    const execution = exec([
      metrics({
        wallMs: 2000,
        timeline: [
          { runId: "w1", startMs: 0, endMs: 1800, outcome: "completed" },
          { runId: "w2", startMs: 100, endMs: 2000, outcome: "completed" },
        ],
      }),
    ]);
    const result = computeTimeLayout(
      execution,
      ["w1", "w2", INPUT_ID, "cap"],
      INPUT_ID,
      "cap",
    );
    expect(result.positions.w1.y).not.toBe(result.positions.w2.y);
    expect(result.sizes.w1.width).toBeGreaterThan(result.sizes.w2.width * 0.8);
    expect(result.positions[INPUT_ID].x).toBeLessThan(TIMELINE_PAD_LEFT);
    expect(result.positions.cap.x).toBeGreaterThan(
      result.positions.w2.x + result.sizes.w2.width,
    );
    expect(
      result.positions.cap.x - (result.positions.w2.x + result.sizes.w2.width),
    ).toBe(TIMELINE_CAPTAIN_GAP);
  });

  it("serializes workers left-to-right when the second starts after the first ends", () => {
    const execution = exec([
      metrics({
        wallMs: 1500,
        timeline: [
          { runId: "w1", startMs: 0, endMs: 1000, outcome: "completed" },
          { runId: "w2", startMs: 1000, endMs: 1500, outcome: "completed" },
        ],
      }),
    ]);
    const result = computeTimeLayout(execution, ["w1", "w2"], INPUT_ID, null);
    expect(result.positions.w2.x).toBeGreaterThanOrEqual(
      result.positions.w1.x + result.sizes.w1.width - 1,
    );
  });

  it("emits batch dividers for multi-segment turns", () => {
    const execution = exec([
      metrics({
        wallMs: 1000,
        timeline: [{ runId: "w1", startMs: 0, endMs: 800, outcome: "completed" }],
      }),
      metrics({
        wallMs: 600,
        timeline: [{ runId: "w2", startMs: 0, endMs: 500, outcome: "completed" }],
      }),
    ]);
    const result = computeTimeLayout(execution, ["w1", "w2"], INPUT_ID, null);
    expect(result.batchDividers).toHaveLength(1);
    expect(result.batchDividers[0].label).toBe("批次 2");
  });
});
