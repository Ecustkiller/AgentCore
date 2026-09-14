import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();

vi.mock("@/services/api", () => ({
  BASE_URL: "https://api.test.example",
  api: {
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

import {
  clearSidecarWorkspacesAuth,
  looksLikeWorkspacesTokenFailure,
  resolveSidecarWorkspacesAuth,
} from "../workspacesToken";

describe("workspacesToken", () => {
  beforeEach(() => {
    clearSidecarWorkspacesAuth();
    apiPost.mockReset();
  });

  afterEach(() => {
    clearSidecarWorkspacesAuth();
  });

  it("mints via POST /v1/workspaces/token and returns {baseUrl, apiKey}", async () => {
    apiPost.mockResolvedValue({
      token: "workspaces-jwt-1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const creds = await resolveSidecarWorkspacesAuth({ force: true });

    expect(apiPost).toHaveBeenCalledWith("/v1/workspaces/token");
    expect(creds).toEqual({
      baseUrl: "https://api.test.example/v1/workspaces",
      apiKey: "workspaces-jwt-1",
    });
  });

  it("accepts expires_in_sec like folders mint", async () => {
    apiPost.mockResolvedValue({
      token: "workspaces-jwt-2",
      expires_in_sec: 7200,
    });

    const creds = await resolveSidecarWorkspacesAuth({ force: true });
    expect(creds?.apiKey).toBe("workspaces-jwt-2");
  });

  it("caches until force / near expiry", async () => {
    apiPost.mockResolvedValue({
      token: "cached-tok",
      expires_in_sec: 7200,
    });

    const first = await resolveSidecarWorkspacesAuth();
    const second = await resolveSidecarWorkspacesAuth();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);

    const forced = await resolveSidecarWorkspacesAuth({ force: true });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(forced?.apiKey).toBe("cached-tok");
  });

  it("returns null on mint failure (no fake success)", async () => {
    apiPost.mockRejectedValue(new Error("network down"));

    await expect(
      resolveSidecarWorkspacesAuth({ force: true }),
    ).resolves.toBeNull();
  });

  it("returns null when response lacks token", async () => {
    apiPost.mockResolvedValue({ expires_in_sec: 60 });

    await expect(
      resolveSidecarWorkspacesAuth({ force: true }),
    ).resolves.toBeNull();
  });

  it("clearSidecarWorkspacesAuth drops cache so next resolve remints", async () => {
    apiPost
      .mockResolvedValueOnce({
        token: "old",
        expires_in_sec: 7200,
      })
      .mockResolvedValueOnce({
        token: "new",
        expires_in_sec: 7200,
      });

    await resolveSidecarWorkspacesAuth();
    clearSidecarWorkspacesAuth();
    const again = await resolveSidecarWorkspacesAuth();
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(again?.apiKey).toBe("new");
  });

  it("looksLikeWorkspacesTokenFailure matches unauthorized / code", () => {
    expect(
      looksLikeWorkspacesTokenFailure(
        new Error("workspaces list unauthorized (401)"),
      ),
    ).toBe(true);
    expect(
      looksLikeWorkspacesTokenFailure({
        message: "x",
        code: "workspaces_cloud_unauthorized",
      }),
    ).toBe(true);
    expect(looksLikeWorkspacesTokenFailure(new Error("network down"))).toBe(
      false,
    );
  });
});
