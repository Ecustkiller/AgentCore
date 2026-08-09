import type { Execution } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import { graphViewExecutionEpoch } from "../graphDocument";
import { graphStructureKey } from "../useGraphLayout";

describe("graphStructureKey", () => {
  it("ignores streaming-only fields (structural fingerprint only)", () => {
    const a = graphStructureKey([
      { id: "w1", dependsOn: [], parentRunId: null, replacesRunId: null },
    ]);
    const b = graphStructureKey([
      { id: "w1", dependsOn: [], parentRunId: null, replacesRunId: null },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a run is appended (追加委派)", () => {
    const before = graphStructureKey([
      { id: "w1", dependsOn: [], parentRunId: null },
    ]);
    const after = graphStructureKey([
      { id: "w1", dependsOn: [], parentRunId: null },
      { id: "w2", dependsOn: [], parentRunId: null },
    ]);
    expect(before).not.toBe(after);
  });

  it("changes when replacesRunId appears (补派接手)", () => {
    const before = graphStructureKey([
      { id: "w1", dependsOn: [], replacesRunId: null },
      { id: "w1b", dependsOn: [], replacesRunId: null },
    ]);
    const after = graphStructureKey([
      { id: "w1", dependsOn: [], replacesRunId: null },
      { id: "w1b", dependsOn: [], replacesRunId: "w1" },
    ]);
    expect(before).not.toBe(after);
  });

  it("changes when dependsOn is rewritten to the replacement", () => {
    const before = graphStructureKey([
      { id: "w1b", dependsOn: [], replacesRunId: "w1" },
      { id: "w2", dependsOn: ["w1"] },
    ]);
    const after = graphStructureKey([
      { id: "w1b", dependsOn: [], replacesRunId: "w1" },
      { id: "w2", dependsOn: ["w1b"] },
    ]);
    expect(before).not.toBe(after);
  });
});

describe("graphViewExecutionEpoch", () => {
  it("ignores streaming output length / process chrome", () => {
    const base = {
      runs: [{ id: "w1", dependsOn: [], output: "short" }],
      status: "running",
    } as unknown as Execution;
    const long = {
      runs: [{ id: "w1", dependsOn: [], output: "a".repeat(10_000) }],
      status: "running",
    } as unknown as Execution;
    expect(graphViewExecutionEpoch(base)).toBe(graphViewExecutionEpoch(long));
    expect(graphViewExecutionEpoch(base)).toContain("status=running");
  });

  it("changes when structure or lifecycle status changes", () => {
    const before = {
      runs: [{ id: "w1", dependsOn: [] }],
      status: "running",
    } as unknown as Execution;
    const afterStruct = {
      runs: [
        { id: "w1", dependsOn: [] },
        { id: "w2", dependsOn: [] },
      ],
      status: "running",
    } as unknown as Execution;
    const afterStatus = {
      runs: [{ id: "w1", dependsOn: [] }],
      status: "completed",
    } as unknown as Execution;
    const e0 = graphViewExecutionEpoch(before);
    expect(e0).not.toBe(graphViewExecutionEpoch(afterStruct));
    expect(e0).not.toBe(graphViewExecutionEpoch(afterStatus));
  });
});
