import { describe, expect, it } from "vitest";
import { composerHasSendableDraft } from "../composerAttachments";

describe("composerHasSendableDraft", () => {
  it("allows attachment-only (empty / whitespace text)", () => {
    expect(composerHasSendableDraft("", [{ id: "1" }])).toBe(true);
    expect(composerHasSendableDraft("  \n", [{ id: "1" }])).toBe(true);
  });

  it("requires non-blank text when there are no attachments", () => {
    expect(composerHasSendableDraft("", [])).toBe(false);
    expect(composerHasSendableDraft("   ", [])).toBe(false);
    expect(composerHasSendableDraft("hi", [])).toBe(true);
  });
});
