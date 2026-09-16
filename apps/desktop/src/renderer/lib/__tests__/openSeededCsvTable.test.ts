import { ApiError } from "@/services/api";
import * as tablesApi from "@/services/tables";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSeededCsvCandidate,
  tryNavigateSeededCsv,
} from "../openSeededCsvTable";

vi.mock("@/lib/preview", () => ({
  isWebPreview: () => false,
}));

vi.mock("@/services/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/tables")>();
  return {
    ...actual,
    lookupTableBySource: vi.fn(),
  };
});

const lookup = vi.mocked(tablesApi.lookupTableBySource);

describe("openSeededCsvTable", () => {
  beforeEach(() => {
    lookup.mockReset();
  });
  afterEach(() => {
    lookup.mockReset();
  });

  it("skips attachments and non-csv", () => {
    expect(isSeededCsvCandidate("attachments/a.csv")).toBe(false);
    expect(isSeededCsvCandidate("notes.md")).toBe(false);
    expect(isSeededCsvCandidate("客户.CSV")).toBe(true);
  });

  it("navigates on lookup hit and opens nothing on 404", async () => {
    const go = vi.fn();
    lookup.mockResolvedValueOnce({
      id: "tbl-1",
      title: "客户",
      conversationId: null,
      schemaVersion: 1,
      rowCount: 1,
      sourcePath: "客户.csv",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-13T00:00:00Z",
    });
    await expect(
      tryNavigateSeededCsv({ path: "客户.csv", workspaceId: "folder:f1" }, go),
    ).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith({
      path: "客户.csv",
      folderId: "f1",
      conversationId: null,
    });
    expect(go).toHaveBeenCalledWith("/tables/tbl-1");

    lookup.mockRejectedValueOnce(new ApiError(404, "{}"));
    go.mockReset();
    await expect(
      tryNavigateSeededCsv({ path: "客户.csv", conversationId: "c1" }, go),
    ).resolves.toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});
