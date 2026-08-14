import { statusPillInline } from "@/components/ui/tone-presets";
import { describe, expect, it } from "vitest";
import { FINDING_SEVERITY, FINDING_STATUS } from "../findings";

describe("FINDING_STATUS tones", () => {
  it("maps escalated and unanswered to primary (needs you)", () => {
    expect(FINDING_STATUS.escalated.pill).toBe(statusPillInline.primary);
    expect(FINDING_STATUS.unanswered.pill).toBe(statusPillInline.primary);
    expect(FINDING_STATUS.open.pill).toBe(statusPillInline.primary);
  });
});

describe("FINDING_SEVERITY tones", () => {
  it("keeps critical 致命 as destructive (classification)", () => {
    expect(FINDING_SEVERITY.critical.label).toBe("致命");
    expect(FINDING_SEVERITY.critical.pill).toBe(statusPillInline.destructive);
  });
});
