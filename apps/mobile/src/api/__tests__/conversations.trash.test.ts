import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { listConversationTrash } from "../conversations";

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function fail(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  };
}

describe("listConversationTrash", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("GETs trash and keeps the server's items, retention, and total", async () => {
    const row = {
      id: "c1",
      title: "定价讨论",
      folder_id: "f1",
      message_count: 24,
      created_at: "2026-07-01T00:00:00Z",
      deleted_at: "2026-08-10T09:00:00Z",
      purge_at: "2026-09-09T09:00:00Z",
    };
    apiFetch.mockResolvedValue(
      ok({
        data: [row],
        total: 1,
        retention_days: 30,
      }),
    );

    const trash = await listConversationTrash();

    expect(apiFetch).toHaveBeenCalledWith("/v1/conversations/trash");
    expect(trash.items).toEqual([row]);
    expect(trash.retention_days).toBe(30);
    expect(trash.total).toBe(1);
  });

  it("throws on non-2xx", async () => {
    apiFetch.mockResolvedValue(fail(500));
    await expect(listConversationTrash()).rejects.toThrow(
      "加载最近删除失败 (500)",
    );
  });
});
