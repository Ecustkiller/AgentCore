import { isDebateTaggedRun } from "@agentcore/graph-layout";
import { describe, expect, it } from "vitest";

describe("graph-layout isDebateTaggedRun", () => {
  it("recognizes stance and leftover participant groups, not a fake debate: prefix", () => {
    expect(isDebateTaggedRun({ stance: "pro", group: null })).toBe(true);
    expect(isDebateTaggedRun({ stance: null, group: "debate:debate" })).toBe(
      true,
    );
    expect(isDebateTaggedRun({ stance: null, group: "debate:red_team" })).toBe(
      true,
    );
    expect(
      isDebateTaggedRun({ stance: null, group: "debate:roundtable" }),
    ).toBe(true);
    expect(isDebateTaggedRun({ stance: null, group: "debate:witness" })).toBe(
      true,
    );
    expect(isDebateTaggedRun({ stance: null, group: "debate:topic" })).toBe(
      false,
    );
    expect(isDebateTaggedRun({ stance: null, group: "workers" })).toBe(false);
    expect(isDebateTaggedRun({ stance: null, group: null })).toBe(false);
  });
});
