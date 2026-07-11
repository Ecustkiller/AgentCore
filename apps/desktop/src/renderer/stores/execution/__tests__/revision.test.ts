import { describe, expect, it } from "vitest";
import { revisionRootId } from "../revision";

describe("revisionRootId", () => {
  it("returns the run itself when it has no revisionOf", () => {
    expect(
      revisionRootId("run-1", [
        { id: "run-1", revisionOf: null },
        { id: "run-2", revisionOf: null },
      ]),
    ).toBe("run-1");
  });

  it("walks star-topology revisions back to the original", () => {
    const runs = [
      { id: "run-1", revisionOf: null },
      { id: "run-1_r2", revisionOf: "run-1" },
      { id: "run-1_r3", revisionOf: "run-1" },
    ];
    expect(revisionRootId("run-1_r3", runs)).toBe("run-1");
    expect(revisionRootId("run-1_r2", runs)).toBe("run-1");
    expect(revisionRootId("run-1", runs)).toBe("run-1");
  });

  it("walks a linear revisionOf chain", () => {
    expect(
      revisionRootId("v3", [
        { id: "v1", revisionOf: null },
        { id: "v2", revisionOf: "v1" },
        { id: "v3", revisionOf: "v2" },
      ]),
    ).toBe("v1");
  });

  it("stops on a missing parent or cycle without looping forever", () => {
    expect(
      revisionRootId("orphan", [{ id: "orphan", revisionOf: "ghost" }]),
    ).toBe("orphan");
    expect(
      revisionRootId("a", [
        { id: "a", revisionOf: "b" },
        { id: "b", revisionOf: "a" },
      ]),
    ).toBe("a");
  });
});
