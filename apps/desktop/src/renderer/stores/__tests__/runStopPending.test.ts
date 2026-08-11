import { beforeEach, describe, expect, it } from "vitest";
import { useRunStopPendingStore } from "../runStopPending";

describe("useRunStopPendingStore", () => {
  beforeEach(() => {
    useRunStopPendingStore.getState().reset();
  });

  it("tracks node and team pending keys separately", () => {
    const s = useRunStopPendingStore.getState();
    s.markPending("e1", "r1");
    s.markPending("e1", null);
    expect(s.isPending("e1", "r1")).toBe(true);
    expect(s.isPending("e1", null)).toBe(true);
    expect(s.isRunCovered("e1", "r1")).toBe(true);
    expect(s.isRunCovered("e1", "r2")).toBe(true);
    expect(s.isRunCovered("e1", "r9")).toBe(true);
  });

  it("clears settled runs without pretending they were cancelled early", () => {
    const s = useRunStopPendingStore.getState();
    s.markPending("e1", "r1");
    s.clearIfSettled("e1", "r1", "running");
    expect(s.isPending("e1", "r1")).toBe(true);
    s.clearIfSettled("e1", "r1", "cancelled");
    expect(s.isPending("e1", "r1")).toBe(false);
  });

  it("clears team pending only when no workers remain active", () => {
    const s = useRunStopPendingStore.getState();
    s.markPending("e1", null);
    s.clearAllIfIdle("e1", true);
    expect(s.isPending("e1", null)).toBe(true);
    s.clearAllIfIdle("e1", false);
    expect(s.isPending("e1", null)).toBe(false);
  });
});
