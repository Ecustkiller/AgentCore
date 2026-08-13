import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({
  api: { post: vi.fn() },
}));

vi.mock("@/services/sidecarRouting", () => ({
  getActiveSidecarTarget: vi.fn(() => null),
}));

import { api } from "@/services/api";
import { getActiveSidecarTarget } from "@/services/sidecarRouting";
import { submitDebateSteer } from "../debate";

const post = vi.mocked(api.post);

describe("submitDebateSteer", () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ ok: true, queued: 1 });
  });

  it("posts continue with focus/ask to debate-steer", async () => {
    await submitDebateSteer("conv-1", {
      executionId: "exec-1",
      decision: {
        kind: "continue",
        focus: "定价",
        ask: "谁兜底？",
        askTarget: "pro",
      },
    });
    expect(post).toHaveBeenCalledWith("/v1/conversations/conv-1/debate-steer", {
      execution_id: "exec-1",
      decision: "continue",
      focus: "定价",
      ask: "谁兜底？",
      ask_target: "pro",
    });
  });

  it("posts conclude without focus", async () => {
    await submitDebateSteer("conv-1", {
      executionId: "exec-1",
      decision: { kind: "conclude", ask: "", askTarget: "" },
    });
    expect(post).toHaveBeenCalledWith("/v1/conversations/conv-1/debate-steer", {
      execution_id: "exec-1",
      decision: "conclude",
      focus: "",
      ask: "",
      ask_target: "",
    });
  });

  // 收场后（末轮边界已过、正在结辩/出简报）引擎 ok=false：调用方据此改口，
  // 不能把「没有下一轮来捞它」的掌舵仍显示成「已发送·下一轮生效」。
  it("reports the engine's rejection instead of echoing 已发送", async () => {
    post.mockResolvedValue({ ok: false, queued: 0 });
    await expect(
      submitDebateSteer("conv-1", {
        executionId: "exec-1",
        decision: { kind: "conclude", ask: "", askTarget: "" },
      }),
    ).resolves.toBe(false);
  });

  it("reports acceptance while the debate still has a boundary ahead", async () => {
    await expect(
      submitDebateSteer("conv-1", {
        executionId: "exec-1",
        decision: { kind: "conclude", ask: "", askTarget: "" },
      }),
    ).resolves.toBe(true);
  });

  it("relays the sidecar verdict for local turns", async () => {
    vi.mocked(getActiveSidecarTarget).mockReturnValueOnce({
      rootId: "root-1",
      subpath: undefined,
    } as never);
    const debateSteer = vi.fn().mockResolvedValue({ accepted: false });
    vi.stubGlobal("window", { sidecarApi: { debateSteer } });
    await expect(
      submitDebateSteer("conv-1", {
        executionId: "exec-1",
        decision: {
          kind: "continue",
          focus: "",
          ask: "再问一轮",
          askTarget: "",
        },
      }),
    ).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
