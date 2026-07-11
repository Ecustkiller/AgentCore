import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import { useInteractionStore } from "@/stores/interactions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideDebateRound } from "../debate";

vi.mock("@/services/interaction", () => ({
  resolveInteraction: vi.fn(),
}));

const resolve = vi.mocked(resolveInteraction);

function seed(id: string) {
  useInteractionStore.getState().upsertRequired({
    kind: "debate_round",
    conversationId: "conv-1",
    messageId: "m1",
    payload: { decision_id: id },
  });
}

beforeEach(() => {
  useInteractionStore.getState().clear();
  resolve.mockReset();
  resolve.mockResolvedValue(undefined);
});

describe("decideDebateRound", () => {
  it("posts continue with decision/focus/ask/ask_target via resolveInteraction", async () => {
    seed("dec-1");
    await decideDebateRound("conv-1", "dec-1", {
      kind: "continue",
      focus: "成本",
      ask: "谁来背锅？",
      askTarget: "pro",
    });

    expect(resolve).toHaveBeenCalledWith("conv-1", "dec-1", {
      kind: "debate_round",
      decision: "continue",
      focus: "成本",
      ask: "谁来背锅？",
      ask_target: "pro",
    });
  });

  it("posts conclude with empty focus (focus only rides continue)", async () => {
    seed("dec-2");
    await decideDebateRound("conv-1", "dec-2", {
      kind: "conclude",
      ask: "记下这句",
      askTarget: "",
    });

    expect(resolve).toHaveBeenCalledWith("conv-1", "dec-2", {
      kind: "debate_round",
      decision: "conclude",
      focus: "",
      ask: "记下这句",
      ask_target: "",
    });
  });

  it("410/404 → orphaned (假卡可见)", async () => {
    seed("dec-stale");
    resolve.mockRejectedValueOnce(new ApiError(404, "gone"));
    await expect(
      decideDebateRound("conv-1", "dec-stale", {
        kind: "continue",
        focus: "",
        ask: "",
        askTarget: "",
      }),
    ).resolves.toBe("orphaned");
    expect(useInteractionStore.getState().get("dec-stale")?.status).toBe(
      "orphaned",
    );
  });

  it("rethrows non-404 failures so the card can retry", async () => {
    seed("dec-1");
    const err = new ApiError(500, "boom");
    resolve.mockRejectedValueOnce(err);
    await expect(
      decideDebateRound("conv-1", "dec-1", {
        kind: "conclude",
        ask: "",
        askTarget: "",
      }),
    ).rejects.toBe(err);
  });
});
