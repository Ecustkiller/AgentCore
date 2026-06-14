import { resolveTurnCost, splitPayroll } from "@/lib/cost";
import { describe, expect, it } from "vitest";

describe("splitPayroll", () => {
  it("derives the CEO row as turn total − Σworkers (团队工资单 differentiator)", () => {
    // 回合 ¥0.12 = CEO ¥0.03 + 调研员 ¥0.05 + 写作 ¥0.04 (doc example, integer units).
    expect(splitPayroll(12, [5, 4])).toEqual({
      captainCost: 3,
      workersTotal: 9,
      total: 12,
      maxCost: 5, // biggest single row (调研员) — bars normalise over it
    });
  });

  it("shows no captain spend until the turn total is known (message_end)", () => {
    // Mid-flight: turnTotal null → captain 0, total falls back to the worker sum.
    expect(splitPayroll(null, [5, 4])).toEqual({
      captainCost: 0,
      workersTotal: 9,
      total: 9,
      maxCost: 5,
    });
  });

  it("floors the captain remainder at 0 (never negative)", () => {
    // Defensive: if the workers somehow exceed the reported total, captain clamps.
    expect(splitPayroll(8, [5, 4]).captainCost).toBe(0);
  });

  it("floors maxCost at 1 for an all-zero turn (no divide-by-zero bars)", () => {
    expect(splitPayroll(0, [0, 0])).toEqual({
      captainCost: 0,
      workersTotal: 0,
      total: 0,
      maxCost: 1,
    });
  });

  it("normalises over the captain when it is the biggest row", () => {
    // CEO ¥10, workers ¥1 each → the captain is the max.
    expect(splitPayroll(12, [1, 1]).maxCost).toBe(10);
  });

  it("handles a soloing captain (no workers)", () => {
    expect(splitPayroll(7, [])).toEqual({
      captainCost: 7,
      workersTotal: 0,
      total: 7,
      maxCost: 7,
    });
  });
});

describe("resolveTurnCost", () => {
  it("prefers the authoritative turn total when known", () => {
    expect(resolveTurnCost(28, [10, 5])).toBe(28);
  });

  it("returns a known total of 0 verbatim (known, not unknown)", () => {
    expect(resolveTurnCost(0, [10])).toBe(0);
  });

  it("falls back to the run sum when there is no turn total (stopped/crashed)", () => {
    expect(resolveTurnCost(null, [10, 5])).toBe(15);
  });

  it("returns null when there is nothing real to show (无花销不显，§7.5)", () => {
    expect(resolveTurnCost(null, [0, 0])).toBeNull();
    expect(resolveTurnCost(null, [])).toBeNull();
  });
});
