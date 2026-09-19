import { describe, expect, it } from "vitest";
import { actAuthorizedByLabel, formatActBandLabel } from "../actAuthLabels";

describe("actAuthorizedByLabel", () => {
  it("maps auto; unknown/old stamps return null", () => {
    expect(actAuthorizedByLabel("auto")).toBe("自动开辩");
    expect(actAuthorizedByLabel("stage_card")).toBeNull();
    expect(actAuthorizedByLabel("preview")).toBeNull();
    expect(actAuthorizedByLabel(null)).toBeNull();
    expect(actAuthorizedByLabel(undefined)).toBeNull();
  });
});

describe("formatActBandLabel", () => {
  it("appends auth badge only for auto", () => {
    expect(formatActBandLabel("辩论对抗", "act-2", "auto")).toBe(
      "辩论对抗 · 自动开辩",
    );
    expect(formatActBandLabel("辩论对抗", "act-2", "stage_card")).toBe(
      "辩论对抗",
    );
    expect(formatActBandLabel(null, "act-2", "auto")).toBe("act-2 · 自动开辩");
    expect(formatActBandLabel("调研", "act-1", null)).toBe("调研");
  });
});
