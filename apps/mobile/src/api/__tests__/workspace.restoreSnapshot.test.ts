import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { restoreSnapshot } from "../workspace";

describe("restoreSnapshot", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("POST …/snapshots/{id}/restore", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200 });
    await expect(restoreSnapshot("c1", "snap-1")).resolves.toBeUndefined();
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/c1/snapshots/snap-1/restore",
      { method: "POST" },
    );
  });

  it("HTTP 非 2xx → 抛错", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 409 });
    await expect(restoreSnapshot("c1", "snap-x")).rejects.toThrow(
      /恢复快照失败/,
    );
  });
});
