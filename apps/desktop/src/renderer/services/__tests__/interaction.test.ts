import { api } from "@/services/api";
import { getActiveSidecarTarget } from "@/services/sidecarRouting";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERACTION_RESOLVE_TIMEOUT_MS,
  resolveInteraction,
} from "../interaction";

vi.mock("@/services/api", () => ({ api: { post: vi.fn() } }));
vi.mock("@/services/sidecarRouting", () => ({
  getActiveSidecarTarget: vi.fn(() => null),
}));

const post = vi.mocked(api.post);
const sidecarTarget = vi.mocked(getActiveSidecarTarget);

let respondMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue(undefined);
  sidecarTarget.mockReset();
  sidecarTarget.mockReturnValue(null);
  respondMock = vi.fn().mockResolvedValue({ resolved: true });
  (globalThis as Record<string, unknown>).window = {
    sidecarApi: { respond: respondMock },
  };
});

describe("resolveInteraction (统一 choke point)", () => {
  it("cloud origin: POSTs the kind body to the interactions endpoint", async () => {
    await resolveInteraction(
      "conv-1",
      "ix-1",
      {
        kind: "approval",
        decision: "approve",
      },
      "cloud",
    );

    expect(sidecarTarget).not.toHaveBeenCalled();
    expect(respondMock).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/interactions/ix-1",
      { kind: "approval", decision: "approve" },
      INTERACTION_RESOLVE_TIMEOUT_MS,
    );
  });

  it("cloud origin: routes escalate bodies the same way", async () => {
    await resolveInteraction(
      "conv-1",
      "esc-1",
      {
        kind: "escalation",
        answer: "选 A",
        use_assumption: false,
        transfer_ownership: false,
      },
      "cloud",
    );
    expect(post).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/interactions/esc-1",
      {
        kind: "escalation",
        answer: "选 A",
        use_assumption: false,
        transfer_ownership: false,
      },
      INTERACTION_RESOLVE_TIMEOUT_MS,
    );
  });

  it("sidecar origin: forwards to sidecarApi.respond (never cloud POST)", async () => {
    sidecarTarget.mockReturnValue({ rootId: "root-9", subpath: "scratch/c1" });

    await resolveInteraction(
      "conv-1",
      "ix-2",
      {
        kind: "approval",
        decision: "deny",
      },
      "sidecar",
    );

    expect(post).not.toHaveBeenCalled();
    expect(respondMock).toHaveBeenCalledWith({
      rootId: "root-9",
      subpath: "scratch/c1",
      requestId: "ix-2",
      conversationId: "conv-1",
      result: { kind: "approval", decision: "deny" },
    });
  });

  it("sidecar origin: surfaces resolved:false so the card can retry", async () => {
    sidecarTarget.mockReturnValue({ rootId: "root-9", subpath: "" });
    respondMock.mockResolvedValueOnce({ resolved: false });

    await expect(
      resolveInteraction(
        "conv-1",
        "esc-gone",
        {
          kind: "escalation",
          answer: "选 A",
          use_assumption: false,
          transfer_ownership: false,
        },
        "sidecar",
      ),
    ).rejects.toThrow(/不存在或已处理/);
    expect(post).not.toHaveBeenCalled();
  });

  it("regression: cloud fulfill settle uses HTTP even when a sidecar turn is active", async () => {
    // Same conversation can host a live local sidecar turn AND cloud-bridged
    // CLIENT_TOOL ops on the device fulfill stream. Guessing by activeSidecarTurns
    // would send the cloud settle to sidecar → {resolved:false} → channel dead.
    sidecarTarget.mockReturnValue({
      rootId: "root-sidecar",
      subpath: "scratch/c1",
      turnId: "turn-local",
    });

    await resolveInteraction(
      "conv-1",
      "op-from-fulfill-stream",
      {
        kind: "client_tool",
        ok: true,
        value: { written: true },
      },
      "cloud",
    );

    expect(respondMock).not.toHaveBeenCalled();
    expect(sidecarTarget).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/interactions/op-from-fulfill-stream",
      {
        kind: "client_tool",
        ok: true,
        value: { written: true },
      },
      INTERACTION_RESOLVE_TIMEOUT_MS,
    );
  });
});
