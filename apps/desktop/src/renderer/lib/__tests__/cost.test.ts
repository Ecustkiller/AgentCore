import { resolveTurnCost, resolveTurnDisplayMoney } from "@/lib/cost";
import { describe, expect, it } from "vitest";

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

describe("resolveTurnDisplayMoney", () => {
  it("prefers turn billed total, then estimated_total", () => {
    expect(
      resolveTurnDisplayMoney({ total: 28, estimated_total: 99 }, []),
    ).toEqual({ nano: 28, estimated: false });
    expect(
      resolveTurnDisplayMoney({ total: 0, estimated_total: 99 }, []),
    ).toEqual({ nano: 99, estimated: true });
  });

  it("falls back to run estimated sum when turn cost is absent", () => {
    expect(
      resolveTurnDisplayMoney(null, [
        { total: 0, estimated_total: 10 },
        { total: 0, estimated_total: 5 },
      ]),
    ).toEqual({ nano: 15, estimated: true });
  });

  it("returns null when nothing real to show", () => {
    expect(resolveTurnDisplayMoney(null, [])).toBeNull();
    expect(
      resolveTurnDisplayMoney(null, [{ total: 0 }, { total: 0 }]),
    ).toBeNull();
  });
});
