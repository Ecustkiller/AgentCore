import { describe, expect, it } from "vitest";
import { foldInteractions } from "../foldInteractions";

const approvalRequired = {
  type: "approval_required",
  payload: {
    approval_id: "a1",
    tool_call_id: "a1",
    tool_name: "file_delete",
    arguments: { permanent: true },
  },
};

describe("foldInteractions terminal close", () => {
  it("orphans leftover hot approval on turn_end interrupted", () => {
    const leaves = foldInteractions([
      approvalRequired,
      { type: "turn_end", payload: { finish_reason: "interrupted" } },
    ]);
    expect(leaves).toEqual([
      expect.objectContaining({
        kind: "approval",
        id: "a1",
        status: "orphaned",
      }),
    ]);
  });

  it("orphans leftover hot approval on message_end interrupted", () => {
    const leaves = foldInteractions([
      approvalRequired,
      { type: "message_end", payload: { finish_reason: "interrupted" } },
    ]);
    expect(leaves[0]?.status).toBe("orphaned");
  });

  it("keeps hot approval pending without a terminal close", () => {
    expect(foldInteractions([approvalRequired])[0]?.status).toBe("pending");
  });

  it("does not orphan ask_user on turn_end", () => {
    const leaves = foldInteractions([
      {
        type: "checkpoint_required",
        payload: { checkpoint_id: "cp1", question: "继续吗？" },
      },
      { type: "turn_end", payload: { finish_reason: "interrupted" } },
    ]);
    expect(leaves[0]).toMatchObject({ kind: "ask_user", status: "pending" });
  });

  it("does not orphan hot approval on paused message_end", () => {
    const leaves = foldInteractions([
      approvalRequired,
      { type: "message_end", payload: { finish_reason: "paused" } },
    ]);
    expect(leaves[0]?.status).toBe("pending");
  });

  it("keeps resolved approval resolved after turn_end", () => {
    const leaves = foldInteractions([
      approvalRequired,
      {
        type: "approval_resolved",
        payload: { approval_id: "a1", tool_call_id: "a1", decision: "approve" },
      },
      { type: "turn_end", payload: { finish_reason: "end_turn" } },
    ]);
    expect(leaves[0]?.status).toBe("resolved");
  });
});
