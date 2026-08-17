import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  BASE_URL: "/api",
}));

import { createShare, listShares, revokeShare, shareLink } from "../sharing";

function okJson(body: unknown, status = 200) {
  return {
    ok: true,
    status,
    json: async () => body,
  };
}

function fail(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

const share = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  url: "/shared/s1",
  title: "周报",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: null,
  ...over,
});

beforeEach(() => {
  apiFetch.mockReset();
});

describe("shareLink", () => {
  it("keeps the API prefix so nginx can proxy /shared to the backend", () => {
    expect(shareLink(share({ url: "/shared/abc" }))).toBe("/api/shared/abc");
  });

  it("passes an already-absolute url through unchanged", () => {
    const abs = "https://share.example.com/shared/abc";
    expect(shareLink(share({ url: abs }))).toBe(abs);
  });
});

describe("share CRUD", () => {
  it("listShares GETs /v1/conversations/{id}/shares and unwraps data", async () => {
    const data = [share({ id: "a" }), share({ id: "b" })];
    apiFetch.mockResolvedValue(okJson({ data, total: 2 }));

    await expect(listShares("c1")).resolves.toEqual(data);
    expect(apiFetch).toHaveBeenCalledWith("/v1/conversations/c1/shares");
  });

  it("createShare POSTs expires_in_days to the shares endpoint", async () => {
    const made = share({ id: "new" });
    apiFetch.mockResolvedValue(okJson(made, 201));

    await expect(createShare("c1", { expires_in_days: 7 })).resolves.toEqual(
      made,
    );
    expect(apiFetch).toHaveBeenCalledWith("/v1/conversations/c1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_in_days: 7 }),
    });
  });

  it("createShare sends null expiry for a permanent link", async () => {
    apiFetch.mockResolvedValue(okJson(share(), 201));
    await createShare("c1", { expires_in_days: null });
    expect(apiFetch).toHaveBeenCalledWith("/v1/conversations/c1/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_in_days: null }),
    });
  });

  it("revokeShare DELETEs /v1/conversations/{id}/shares/{shareId}", async () => {
    apiFetch.mockResolvedValue(okJson({ status: "ok" }));
    await revokeShare("c1", "s9");
    expect(apiFetch).toHaveBeenCalledWith("/v1/conversations/c1/shares/s9", {
      method: "DELETE",
    });
  });

  it("non-2xx throws", async () => {
    apiFetch.mockResolvedValue(fail(500));
    await expect(listShares("c1")).rejects.toThrow("加载分享链接失败 (500)");
  });
});
