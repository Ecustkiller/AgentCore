import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { getTurnFilesDiff } from "../turnFilesDiff";

describe("getTurnFilesDiff", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("GET …/files/diff 并映射 wire → camel（available / baselineSnapshotId / changes）", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        message_id: "m1",
        baseline_snapshot_id: "snap-1",
        available: true,
        data: [
          {
            path: "src/a.ts",
            change_type: "modified",
            base_sha: "bsha",
            result_sha: "rsha",
            is_binary: false,
            content: "after",
            size_bytes: 5,
            base_content: "before",
          },
          {
            path: "new.txt",
            change_type: "added",
            base_sha: null,
            result_sha: "nsha",
            is_binary: false,
            content: "hi",
            size_bytes: 2,
          },
        ],
        total: 2,
        added: 1,
        modified: 1,
        deleted: 0,
      }),
    });

    const diff = await getTurnFilesDiff("c1", "m1");

    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/c1/messages/m1/files/diff",
    );
    expect(diff).toEqual({
      messageId: "m1",
      baselineSnapshotId: "snap-1",
      available: true,
      changes: [
        {
          path: "src/a.ts",
          changeType: "modified",
          baseSha: "bsha",
          resultSha: "rsha",
          isBinary: false,
          content: "after",
          sizeBytes: 5,
          baseContent: "before",
        },
        {
          path: "new.txt",
          changeType: "added",
          baseSha: null,
          resultSha: "nsha",
          isBinary: false,
          content: "hi",
          sizeBytes: 2,
          baseContent: null,
        },
      ],
      total: 2,
      added: 1,
      modified: 1,
      deleted: 0,
    });
  });

  it("available=false / 无基线时仍映射（data→changes 为空）", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        message_id: "m2",
        baseline_snapshot_id: null,
        available: false,
        data: [],
        total: 0,
        added: 0,
        modified: 0,
        deleted: 0,
      }),
    });

    const diff = await getTurnFilesDiff("c9", "m2");
    expect(diff.available).toBe(false);
    expect(diff.baselineSnapshotId).toBeNull();
    expect(diff.changes).toEqual([]);
  });

  it("HTTP 非 2xx → 抛错", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(getTurnFilesDiff("c1", "m1")).rejects.toThrow(
      /加载回合文件改动失败/,
    );
  });
});
