import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();

vi.mock("@/services/api", () => ({
  BASE_URL: "https://api.test.example",
  api: {
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

import {
  clearSidecarInference,
  resolveSidecarInference,
} from "../inferenceToken";

describe("inferenceToken", () => {
  beforeEach(() => {
    clearSidecarInference();
    apiPost.mockReset();
  });

  afterEach(() => {
    clearSidecarInference();
  });

  it("mints via POST /v1/inference/token without body when no conversationId", async () => {
    apiPost.mockResolvedValue({
      token: "inf-jwt-1",
      expires_in_sec: 3600,
      model: "account-default-model",
    });

    const creds = await resolveSidecarInference({ force: true });

    expect(apiPost).toHaveBeenCalledWith("/v1/inference/token");
    expect(creds).toEqual({
      baseUrl: "https://api.test.example/v1/inference/v1",
      apiKey: "inf-jwt-1",
      model: "account-default-model",
    });
  });

  it("posts { conversation_id } when conversationId is set", async () => {
    apiPost.mockResolvedValue({
      token: "inf-jwt-c1",
      expires_in_sec: 3600,
      model: "conv-model-a",
    });

    const creds = await resolveSidecarInference({
      force: true,
      conversationId: "c1",
    });

    expect(apiPost).toHaveBeenCalledWith("/v1/inference/token", {
      conversation_id: "c1",
    });
    expect(creds?.model).toBe("conv-model-a");
    expect(creds?.apiKey).toBe("inf-jwt-c1");
  });

  it("caches per conversation until force / switch / near expiry", async () => {
    apiPost
      .mockResolvedValueOnce({
        token: "tok-c1",
        expires_in_sec: 7200,
        model: "model-c1",
      })
      .mockResolvedValueOnce({
        token: "tok-c2",
        expires_in_sec: 7200,
        model: "model-c2",
      })
      .mockResolvedValueOnce({
        token: "tok-c1-b",
        expires_in_sec: 7200,
        model: "model-c1-b",
      });

    const first = await resolveSidecarInference({ conversationId: "c1" });
    const second = await resolveSidecarInference({ conversationId: "c1" });
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first?.model).toBe("model-c1");

    // Session switch → remint with new conversation_id (cache isolated).
    const switched = await resolveSidecarInference({ conversationId: "c2" });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(apiPost).toHaveBeenLastCalledWith("/v1/inference/token", {
      conversation_id: "c2",
    });
    expect(switched?.model).toBe("model-c2");

    const forced = await resolveSidecarInference({
      force: true,
      conversationId: "c1",
    });
    expect(apiPost).toHaveBeenCalledTimes(3);
    expect(apiPost).toHaveBeenLastCalledWith("/v1/inference/token", {
      conversation_id: "c1",
    });
    expect(forced?.apiKey).toBe("tok-c1-b");
  });

  it("does not reuse account-default cache for a conversation mint", async () => {
    apiPost
      .mockResolvedValueOnce({
        token: "tok-default",
        expires_in_sec: 7200,
        model: "default-model",
      })
      .mockResolvedValueOnce({
        token: "tok-c1",
        expires_in_sec: 7200,
        model: "conv-model",
      });

    await resolveSidecarInference();
    const withConv = await resolveSidecarInference({ conversationId: "c1" });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(withConv?.model).toBe("conv-model");
  });

  it("returns null on mint failure (no fake success)", async () => {
    apiPost.mockRejectedValue(new Error("network down"));

    await expect(
      resolveSidecarInference({ force: true, conversationId: "c1" }),
    ).resolves.toBeNull();
  });

  it("clearSidecarInference drops cache so next resolve remints", async () => {
    apiPost
      .mockResolvedValueOnce({
        token: "old",
        expires_in_sec: 7200,
        model: "m1",
      })
      .mockResolvedValueOnce({
        token: "new",
        expires_in_sec: 7200,
        model: "m2",
      });

    await resolveSidecarInference({ conversationId: "c1" });
    clearSidecarInference();
    const again = await resolveSidecarInference({ conversationId: "c1" });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(again?.apiKey).toBe("new");
  });
});
