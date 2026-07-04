import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCanvasTurnView,
  persistCanvasTurnView,
  resolveCanvasTurnView,
} from "../canvasTurnView";

describe("resolveCanvasTurnView", () => {
  it("prefers saved when still available, else natural default", () => {
    const available = new Set(["room", "compare", "graph"] as const);
    expect(resolveCanvasTurnView("compare", "room", available)).toBe("compare");
    expect(resolveCanvasTurnView("timeline", "room", available)).toBe("room");
  });
});

describe("canvas turn view persistence (vitest env = node → stub localStorage)", () => {
  const KEY = "agentcore:canvas-turn-views";
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    } as Storage;
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
  });

  it("migrates a legacy `revisions` preference to the unified `compare` lens", () => {
    // A value persisted before 对比擂台 ∪ 版本对比 merged into one「对比」lens.
    store[KEY] = JSON.stringify({ "conv:turn": "revisions" });
    expect(loadCanvasTurnView("conv", "turn")).toBe("compare");
  });

  it("migrates a legacy `timeline` preference to `graph` (gantt merged into协作图)", () => {
    store[KEY] = JSON.stringify({ "conv:turn": "timeline" });
    expect(loadCanvasTurnView("conv", "turn")).toBe("graph");
  });

  it("round-trips a saved `compare` view and drops unknown values", () => {
    persistCanvasTurnView("conv", "t1", "compare");
    expect(loadCanvasTurnView("conv", "t1")).toBe("compare");
    // Foreign / stale keys never resolve to a view.
    store[KEY] = JSON.stringify({ "conv:t2": "arena", "conv:t3": "graph" });
    expect(loadCanvasTurnView("conv", "t2")).toBeNull();
    expect(loadCanvasTurnView("conv", "t3")).toBe("graph");
  });
});
