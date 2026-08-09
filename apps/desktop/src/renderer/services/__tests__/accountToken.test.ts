import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();

vi.mock("@/services/api", () => ({
  BASE_URL: "https://api.test.example",
  api: {
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

import {
  clearSidecarAccountAuth,
  resolveSidecarAccountAuth,
} from "../accountToken";

describe("accountToken", () => {
  beforeEach(() => {
    clearSidecarAccountAuth();
    apiPost.mockReset();
  });

  afterEach(() => {
    clearSidecarAccountAuth();
  });

  it("mints via POST /v1/account/token and returns {baseUrl, apiKey}", async () => {
    apiPost.mockResolvedValue({
      token: "account-jwt-1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const creds = await resolveSidecarAccountAuth({ force: true });

    expect(apiPost).toHaveBeenCalledWith("/v1/account/token");
    expect(creds).toEqual({
      baseUrl: "https://api.test.example/v1/account",
      apiKey: "account-jwt-1",
    });
  });

  it("accepts expires_in_sec like folders mint", async () => {
    apiPost.mockResolvedValue({
      token: "account-jwt-2",
      expires_in_sec: 7200,
    });

    const creds = await resolveSidecarAccountAuth({ force: true });
    expect(creds?.apiKey).toBe("account-jwt-2");
  });

  it("caches until force / near expiry", async () => {
    apiPost.mockResolvedValue({
      token: "cached-tok",
      expires_in_sec: 7200,
    });

    const first = await resolveSidecarAccountAuth();
    const second = await resolveSidecarAccountAuth();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);

    const forced = await resolveSidecarAccountAuth({ force: true });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(forced?.apiKey).toBe("cached-tok");
  });

  it("returns null on mint failure (no fake success)", async () => {
    apiPost.mockRejectedValue(new Error("network down"));

    await expect(
      resolveSidecarAccountAuth({ force: true }),
    ).resolves.toBeNull();
  });

  it("returns null when response lacks token", async () => {
    apiPost.mockResolvedValue({ expires_in_sec: 60 });

    await expect(
      resolveSidecarAccountAuth({ force: true }),
    ).resolves.toBeNull();
  });

  it("clearSidecarAccountAuth drops cache so next resolve remints", async () => {
    apiPost
      .mockResolvedValueOnce({
        token: "old",
        expires_in_sec: 7200,
      })
      .mockResolvedValueOnce({
        token: "new",
        expires_in_sec: 7200,
      });

    await resolveSidecarAccountAuth();
    clearSidecarAccountAuth();
    const again = await resolveSidecarAccountAuth();
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(again?.apiKey).toBe("new");
  });
});
