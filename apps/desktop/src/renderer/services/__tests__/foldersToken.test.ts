import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();

vi.mock("@/services/api", () => ({
  BASE_URL: "https://api.test.example",
  api: {
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

import {
  clearSidecarFoldersAuth,
  looksLikeFoldersTokenFailure,
  resolveSidecarFoldersAuth,
} from "../foldersToken";

describe("foldersToken", () => {
  beforeEach(() => {
    clearSidecarFoldersAuth();
    apiPost.mockReset();
  });

  afterEach(() => {
    clearSidecarFoldersAuth();
  });

  it("mints via POST /v1/folders/token and returns {baseUrl, apiKey}", async () => {
    apiPost.mockResolvedValue({
      token: "folders-jwt-1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const creds = await resolveSidecarFoldersAuth({ force: true });

    expect(apiPost).toHaveBeenCalledWith("/v1/folders/token");
    expect(creds).toEqual({
      baseUrl: "https://api.test.example/v1/folders",
      apiKey: "folders-jwt-1",
    });
  });

  it("accepts expires_in_sec like inference mint", async () => {
    apiPost.mockResolvedValue({
      token: "folders-jwt-2",
      expires_in_sec: 7200,
    });

    const creds = await resolveSidecarFoldersAuth({ force: true });
    expect(creds?.apiKey).toBe("folders-jwt-2");
  });

  it("caches until force / near expiry", async () => {
    apiPost.mockResolvedValue({
      token: "cached-tok",
      expires_in_sec: 7200,
    });

    const first = await resolveSidecarFoldersAuth();
    const second = await resolveSidecarFoldersAuth();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);

    const forced = await resolveSidecarFoldersAuth({ force: true });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(forced?.apiKey).toBe("cached-tok");
  });

  it("returns null on mint failure (no fake success)", async () => {
    apiPost.mockRejectedValue(new Error("network down"));

    await expect(
      resolveSidecarFoldersAuth({ force: true }),
    ).resolves.toBeNull();
  });

  it("returns null when response lacks token", async () => {
    apiPost.mockResolvedValue({ expires_in_sec: 60 });

    await expect(
      resolveSidecarFoldersAuth({ force: true }),
    ).resolves.toBeNull();
  });

  it("clearSidecarFoldersAuth drops cache so next resolve remints", async () => {
    apiPost
      .mockResolvedValueOnce({
        token: "old",
        expires_in_sec: 7200,
      })
      .mockResolvedValueOnce({
        token: "new",
        expires_in_sec: 7200,
      });

    await resolveSidecarFoldersAuth();
    clearSidecarFoldersAuth();
    const again = await resolveSidecarFoldersAuth();
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(again?.apiKey).toBe("new");
  });

  it("looksLikeFoldersTokenFailure matches unauthorized / code", () => {
    expect(
      looksLikeFoldersTokenFailure(
        new Error("folders list unauthorized (401)"),
      ),
    ).toBe(true);
    expect(
      looksLikeFoldersTokenFailure({
        message: "x",
        code: "folders_cloud_unauthorized",
      }),
    ).toBe(true);
    expect(looksLikeFoldersTokenFailure(new Error("network down"))).toBe(false);
  });
});
