import { describe, expect, it } from "vitest";
import { grantHintsFromAskOption } from "../grantFolderHints";

describe("grantHintsFromAskOption", () => {
  it("returns undefined when neither hint is set", () => {
    expect(grantHintsFromAskOption({})).toBeUndefined();
    expect(grantHintsFromAskOption({ well_known: "home" })).toBeUndefined();
  });

  it("maps snake_case wire fields to camelCase IPC hints", () => {
    expect(
      grantHintsFromAskOption({
        well_known: "desktop",
        target_name: "  6月报表  ",
      }),
    ).toEqual({ wellKnown: "desktop", targetName: "6月报表" });
  });

  it("allows wellKnown alone", () => {
    expect(grantHintsFromAskOption({ well_known: "downloads" })).toEqual({
      wellKnown: "downloads",
    });
  });

  it("allows targetName alone", () => {
    expect(grantHintsFromAskOption({ target_name: "Docs" })).toEqual({
      targetName: "Docs",
    });
  });
});
