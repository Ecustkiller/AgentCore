import { beforeEach, describe, expect, it } from "vitest";
import {
  applyColdInteractionWireEvent,
  bindEmptyColdMessageId,
  clearColdInteractions,
  getColdInteraction,
  listColdPending,
  markColdResolved,
  rekeyColdMessageId,
  upsertColdRequired,
} from "../coldInteractions";

beforeEach(() => {
  clearColdInteractions();
});

describe("coldInteractions · upsertRequired tombstones", () => {
  it("upserts ask_user / plan_review / team_preview required", () => {
    upsertColdRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp1", question: "继续吗？" },
    });
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "c1",
      messageId: "m1",
      payload: {
        checkpoint_id: "tp1",
        primitive: "delegate",
        workers: [],
      },
    });
    expect(getColdInteraction("cp1")?.status).toBe("pending");
    expect(listColdPending("c1")).toHaveLength(2);
  });

  it("resolved stub yields to a live required payload", () => {
    markColdResolved({
      kind: "ask_user",
      id: "cp-stub",
      resolution: { decision: "continue" },
    });
    expect(getColdInteraction("cp-stub")?.payload).toEqual({});

    upsertColdRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m2",
      payload: { checkpoint_id: "cp-stub", question: "还要拍板吗？" },
    });
    expect(getColdInteraction("cp-stub")?.status).toBe("pending");
    expect(getColdInteraction("cp-stub")?.messageId).toBe("m2");
    expect(
      (getColdInteraction("cp-stub")?.payload as { question?: string })
        .question,
    ).toBe("还要拍板吗？");
  });

  it("cold required on a new host messageId replaces a prior resolved entry (round 2+)", () => {
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "c1",
      messageId: "m-turn1",
      payload: {
        checkpoint_id: "tp-reuse",
        primitive: "delegate",
        workers: [],
      },
    });
    markColdResolved({
      kind: "team_preview",
      id: "tp-reuse",
      resolution: { decision: "continue" },
    });
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "c1",
      messageId: "m-turn2",
      payload: {
        checkpoint_id: "tp-reuse",
        primitive: "delegate",
        workers: [{ run_id: "r2", role: "研", task: "t", depends_on: [] }],
      },
    });
    expect(getColdInteraction("tp-reuse")?.status).toBe("pending");
    expect(getColdInteraction("tp-reuse")?.messageId).toBe("m-turn2");
  });

  it("same-host settled replay stays blocked", () => {
    upsertColdRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp-same", question: "一？" },
    });
    markColdResolved({ kind: "ask_user", id: "cp-same" });
    upsertColdRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp-same", question: "重放？" },
    });
    expect(getColdInteraction("cp-same")?.status).toBe("resolved");
    expect(
      (getColdInteraction("cp-same")?.payload as { question?: string })
        .question,
    ).toBe("一？");
  });

  it("status:pending force replaces a resolved cold entry (recovery)", () => {
    upsertColdRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp-force", question: "旧" },
    });
    markColdResolved({ kind: "ask_user", id: "cp-force" });
    upsertColdRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp-force", question: "恢复" },
      status: "pending",
    });
    expect(getColdInteraction("cp-force")?.status).toBe("pending");
    expect(
      (getColdInteraction("cp-force")?.payload as { question?: string })
        .question,
    ).toBe("恢复");
  });
});

describe("coldInteractions · stamp rekey / bind", () => {
  it("rekeys client bubble id to server message id", () => {
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "c1",
      messageId: "client-uuid",
      payload: {
        checkpoint_id: "tp-rekey",
        primitive: "delegate",
        workers: [],
      },
    });
    rekeyColdMessageId("client-uuid", "m-server");
    expect(getColdInteraction("tp-rekey")?.messageId).toBe("m-server");
  });

  it("binds empty messageId on stamp", () => {
    upsertColdRequired({
      kind: "plan_review",
      conversationId: "c1",
      messageId: "",
      payload: { checkpoint_id: "pr-bind", steps: [], pending: [] },
    });
    bindEmptyColdMessageId("c1", "m-server-late");
    expect(getColdInteraction("pr-bind")?.messageId).toBe("m-server-late");
  });
});

describe("coldInteractions · wire events", () => {
  it("applies team_preview_required / resolved", () => {
    applyColdInteractionWireEvent(
      "team_preview_required",
      {
        checkpoint_id: "tp-wire",
        primitive: "delegate",
        workers: [{ run_id: "r1", role: "研", task: "t", depends_on: [] }],
      },
      "c1",
      "m1",
    );
    expect(getColdInteraction("tp-wire")?.status).toBe("pending");
    applyColdInteractionWireEvent(
      "team_preview_resolved",
      { checkpoint_id: "tp-wire", decision: "continue" },
      "c1",
      "m1",
    );
    expect(getColdInteraction("tp-wire")?.status).toBe("resolved");
  });
});
