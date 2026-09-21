// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", () => ({
  hasLocalEngine: vi.fn(() => true),
}));

vi.mock("@/services/sidecarRouting", () => ({
  resolveNewTurnBind: vi.fn(),
  liveSidecarTarget: vi.fn(),
}));

vi.mock("@/services/inferenceToken", () => ({
  resolveSidecarInference: vi.fn(),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "user-1" } }),
  },
}));

import { hasLocalEngine } from "@/lib/capabilities";
import { resolveSidecarInference } from "@/services/inferenceToken";
import {
  liveSidecarTarget,
  resolveNewTurnBind,
} from "@/services/sidecarRouting";
import {
  resetWarmLlmHttpForTests,
  warmLlmHttpOnComposerFocus,
} from "@/services/warmLlmHttp";

const inference = {
  baseUrl: "http://api.test/v1/inference/v1",
  apiKey: "tok",
  model: "flash",
};

describe("warmLlmHttpOnComposerFocus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWarmLlmHttpForTests();
    vi.mocked(hasLocalEngine).mockReturnValue(true);
    vi.mocked(resolveNewTurnBind).mockResolvedValue({
      kind: "live",
      rootId: "root-1",
      subpath: "conv/c1",
    });
    vi.mocked(liveSidecarTarget).mockReturnValue({
      rootId: "root-1",
      subpath: "conv/c1",
    });
    vi.mocked(resolveSidecarInference).mockResolvedValue(inference);
    window.sidecarApi = {
      warmLlmHttp: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.sidecarApi;
  });

  it("kicks sidecar warm with inference on a live local bind", async () => {
    await warmLlmHttpOnComposerFocus("c1");
    expect(window.sidecarApi.warmLlmHttp).toHaveBeenCalledWith({
      rootId: "root-1",
      subpath: "conv/c1",
      inference,
      userId: "user-1",
    });
  });

  it("skips cloud / unbound sessions", async () => {
    vi.mocked(liveSidecarTarget).mockReturnValue(null);
    await warmLlmHttpOnComposerFocus("c-cloud");
    expect(window.sidecarApi.warmLlmHttp).not.toHaveBeenCalled();
  });

  it("retries after a missing mint, then succeeds", async () => {
    vi.mocked(resolveSidecarInference)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(inference);
    await warmLlmHttpOnComposerFocus("c1");
    expect(window.sidecarApi.warmLlmHttp).not.toHaveBeenCalled();
    await warmLlmHttpOnComposerFocus("c1");
    expect(window.sidecarApi.warmLlmHttp).toHaveBeenCalledTimes(1);
  });

  it("dedupes a second focus within the cooldown", async () => {
    await warmLlmHttpOnComposerFocus("c1");
    await warmLlmHttpOnComposerFocus("c1");
    expect(window.sidecarApi.warmLlmHttp).toHaveBeenCalledTimes(1);
  });
});
