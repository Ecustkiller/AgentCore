// @vitest-environment jsdom
import { api } from "@/services/api";
import { getActiveSidecarTarget } from "@/services/sidecarRouting";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitRunStop } from "../runStop";

vi.mock("@/services/api", () => ({ api: { post: vi.fn() } }));
vi.mock("@/services/sidecarRouting", () => ({
  getActiveSidecarTarget: vi.fn(() => null),
}));

const post = vi.mocked(api.post);
const getTarget = vi.mocked(getActiveSidecarTarget);

beforeEach(() => {
  post.mockReset();
  getTarget.mockReset();
  getTarget.mockReturnValue(null);
});

describe("submitRunStop", () => {
  it("posts snake_case body to the run-stop endpoint (one worker)", async () => {
    post.mockResolvedValue({ queued: 1 });

    const out = await submitRunStop("conv-1", {
      executionId: "exec-1",
      runId: "r1",
    });

    expect(out).toEqual({ queued: 1 });
    expect(post).toHaveBeenCalledWith("/v1/conversations/conv-1/run-stop", {
      execution_id: "exec-1",
      run_id: "r1",
    });
  });

  it("omits run scope as null when stopping the whole execution", async () => {
    post.mockResolvedValue({ queued: 3 });

    await submitRunStop("conv-1", { executionId: "exec-1" });

    expect(post).toHaveBeenCalledWith("/v1/conversations/conv-1/run-stop", {
      execution_id: "exec-1",
      run_id: null,
    });
  });

  it("routes local turns to sidecarApi.runStop", async () => {
    getTarget.mockReturnValue({
      rootId: "root-1",
      subpath: "conversations/conv-1",
      turnId: "turn-1",
    });
    const runStop = vi.fn().mockResolvedValue({ queued: 2 });
    window.sidecarApi = { ...window.sidecarApi, runStop };

    const out = await submitRunStop("conv-1", {
      executionId: "exec-1",
      runId: "r2",
    });

    expect(out).toEqual({ queued: 2 });
    expect(runStop).toHaveBeenCalledWith({
      rootId: "root-1",
      subpath: "conversations/conv-1",
      conversationId: "conv-1",
      executionId: "exec-1",
      runId: "r2",
    });
    expect(post).not.toHaveBeenCalled();
  });
});
