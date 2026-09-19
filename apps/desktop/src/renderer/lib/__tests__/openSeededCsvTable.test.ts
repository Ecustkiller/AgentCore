import { describe, expect, it, vi } from "vitest";
import {
  isSeededCsvCandidate,
  tryNavigateSeededCsv,
} from "../openSeededCsvTable";

describe("openSeededCsvTable", () => {
  it("skips attachments and non-csv", () => {
    expect(isSeededCsvCandidate("attachments/a.csv")).toBe(false);
    expect(isSeededCsvCandidate("notes.md")).toBe(false);
    expect(isSeededCsvCandidate("客户.CSV")).toBe(true);
  });

  it("never navigates to /tables", async () => {
    const go = vi.fn();
    await expect(
      tryNavigateSeededCsv({ path: "客户.csv", workspaceId: "folder:f1" }, go),
    ).resolves.toBe(false);
    await expect(
      tryNavigateSeededCsv({ path: "客户.csv", conversationId: "c1" }, go),
    ).resolves.toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});
