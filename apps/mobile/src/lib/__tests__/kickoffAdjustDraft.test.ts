import { afterEach, describe, expect, it } from "vitest";
import {
  clearKickoffAdjustDraft,
  readKickoffAdjustDraft,
  resetKickoffAdjustDraftsForTests,
  writeKickoffAdjustDraft,
} from "../kickoffAdjustDraft";

afterEach(() => {
  resetKickoffAdjustDraftsForTests();
});

describe("kickoffAdjustDraft", () => {
  it("writes and reads by checkpoint id", () => {
    writeKickoffAdjustDraft("tp1", "改成两人");
    expect(readKickoffAdjustDraft("tp1")).toBe("改成两人");
    expect(readKickoffAdjustDraft("tp2")).toBe("");
  });

  it("clear drops memory and storage", () => {
    writeKickoffAdjustDraft("tp1", "先改分工");
    clearKickoffAdjustDraft("tp1");
    expect(readKickoffAdjustDraft("tp1")).toBe("");
  });
});
