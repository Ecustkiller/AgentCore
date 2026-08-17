import { describe, expect, it } from "vitest";
import { retentionRemainingLabel } from "../conversationTrash";

const NOW = Date.parse("2026-08-13T00:00:00Z");
const at = (hoursFromNow: number) =>
  new Date(NOW + hoursFromNow * 3_600_000).toISOString();

describe("retentionRemainingLabel", () => {
  it("floors the remaining days — purge_at is the earliest sweep, not a promise", () => {
    expect(retentionRemainingLabel(at(24 * 30), NOW)).toBe("剩 30 天");
    expect(retentionRemainingLabel(at(24 * 2 + 23), NOW)).toBe("剩 2 天");
  });

  it("calls out the last day and an already-due purge", () => {
    expect(retentionRemainingLabel(at(5), NOW)).toBe("剩不到 1 天");
    expect(retentionRemainingLabel(at(-1), NOW)).toBe("即将清理");
  });

  it("stays quiet on an unparseable timestamp", () => {
    expect(retentionRemainingLabel("not-a-date", NOW)).toBe("");
  });
});
