import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import { runResume } from "@/services/turns";
import { useInteractionStore } from "@/stores/interactions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isInteractionOrphanedError,
  isPendingInteractionsAwaitingError,
  submitInteraction,
} from "../interactionSubmit";

vi.mock("@/services/interaction", () => ({
  resolveInteraction: vi.fn(),
}));
vi.mock("@/services/turns", () => ({
  runResume: vi.fn(),
}));
vi.mock("@/stores/composer", () => ({
  useComposerDraftStore: {
    getState: () => ({ fill: vi.fn() }),
  },
}));

const resolveMock = vi.mocked(resolveInteraction);
const resumeMock = vi.mocked(runResume);
const store = () => useInteractionStore.getState();

beforeEach(() => {
  store().clear();
  resolveMock.mockReset();
  resumeMock.mockReset();
  resolveMock.mockResolvedValue(undefined);
  resumeMock.mockResolvedValue(undefined);
});

describe("submitInteraction path table", () => {
  it("hot path: approval → resolveInteraction + resolved", async () => {
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: { approval_id: "a1", tool_name: "x", arguments: {} },
    });
    const result = await submitInteraction({
      id: "a1",
      kind: "approval",
      conversationId: "c1",
      hotBody: { kind: "approval", decision: "approve" },
    });
    expect(result).toBe("ok");
    expect(resolveMock).toHaveBeenCalledWith("c1", "a1", {
      kind: "approval",
      decision: "approve",
    });
    expect(store().get("a1")?.status).toBe("resolved");
  });

  it("cold path: ask_user → runResume", async () => {
    store().upsertRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp1", question: "q" },
    });
    const result = await submitInteraction({
      id: "cp1",
      kind: "ask_user",
      conversationId: "c1",
      cold: { messageId: "srv-m1", decision: "continue", note: "" },
    });
    expect(result).toBe("ok");
    expect(resumeMock).toHaveBeenCalledWith(
      "srv-m1",
      "continue",
      "",
      undefined,
    );
    expect(store().get("cp1")?.status).toBe("resolved");
  });

  it("410 interaction_orphaned → orphaned status (no reopen)", async () => {
    store().upsertRequired({
      kind: "escalation",
      conversationId: "c1",
      messageId: "m1",
      payload: { escalation_id: "e1", question: "q", assumption: "a" },
    });
    resolveMock.mockRejectedValue(
      new ApiError(
        410,
        JSON.stringify({ detail: { code: "interaction_orphaned" } }),
      ),
    );
    const result = await submitInteraction({
      id: "e1",
      kind: "escalation",
      conversationId: "c1",
      hotBody: {
        kind: "escalation",
        answer: "",
        use_assumption: true,
      },
    });
    expect(result).toBe("orphaned");
    expect(store().get("e1")?.status).toBe("orphaned");
  });

  it("non-410 failure → reopen for retry", async () => {
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: { approval_id: "a1", tool_name: "x", arguments: {} },
    });
    resolveMock.mockRejectedValue(new ApiError(500, "boom"));
    await expect(
      submitInteraction({
        id: "a1",
        kind: "approval",
        conversationId: "c1",
        hotBody: { kind: "approval", decision: "deny" },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(store().get("a1")?.status).toBe("pending");
  });

  it("submitting guard blocks double submit", async () => {
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: { approval_id: "a1", tool_name: "x", arguments: {} },
    });
    let release!: () => void;
    resolveMock.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(undefined);
        }),
    );
    const first = submitInteraction({
      id: "a1",
      kind: "approval",
      conversationId: "c1",
      hotBody: { kind: "approval", decision: "approve" },
    });
    const second = await submitInteraction({
      id: "a1",
      kind: "approval",
      conversationId: "c1",
      hotBody: { kind: "approval", decision: "approve" },
    });
    expect(second).toBe("busy");
    release();
    await first;
  });
});

describe("error helpers", () => {
  it("detects 410 orphaned from detail.code", () => {
    const err = new ApiError(
      410,
      JSON.stringify({ detail: { code: "interaction_orphaned" } }),
    );
    expect(isInteractionOrphanedError(err)).toBe(true);
  });

  it("detects 409 pending_interactions_awaiting", () => {
    const err = new ApiError(
      409,
      JSON.stringify({
        detail: {
          code: "pending_interactions_awaiting",
          pending_kinds: ["approval"],
        },
      }),
    );
    expect(isPendingInteractionsAwaitingError(err)).toBe(true);
  });
});
