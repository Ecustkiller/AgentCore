import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { listTrash, restoreTrash } from "../workspace";

describe("listTrash / restoreTrash", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("GET …/trash → camelCase entries + retentionDays", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            entry_id: "e1",
            original_path: "docs/a.md",
            name: "a.md",
            is_dir: false,
            deleted_at: "2026-08-01T00:00:00Z",
          },
        ],
        retention_days: 30,
        total: 1,
      }),
    });
    await expect(listTrash("c1")).resolves.toEqual({
      entries: [
        {
          entryId: "e1",
          originalPath: "docs/a.md",
          name: "a.md",
          isDir: false,
          deletedAt: "2026-08-01T00:00:00Z",
        },
      ],
      retentionDays: 30,
    });
    expect(apiFetch).toHaveBeenCalledWith("/v1/conversations/c1/trash");
  });

  it("listTrash HTTP 非 2xx → 抛错", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(listTrash("c1")).rejects.toThrow(/加载软删区失败/);
  });

  it("POST …/trash/{id}/restore", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200 });
    await expect(restoreTrash("c1", "e1")).resolves.toBeUndefined();
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/c1/trash/e1/restore",
      { method: "POST" },
    );
  });

  it("restoreTrash HTTP 非 2xx → 抛错", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 409 });
    await expect(restoreTrash("c1", "e1")).rejects.toThrow(/还原失败/);
  });
});
