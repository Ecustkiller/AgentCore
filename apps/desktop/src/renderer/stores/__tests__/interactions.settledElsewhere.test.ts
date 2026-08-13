/**
 * 「已由另一端处理」的判定（云对话多端同权 B2 · P1 · 验收 2）。
 *
 * 线材里没有「谁答的」，所以只认一件事：本端一直显示着 pending，却收到一帧**实时**
 * `*_resolved` ⇒ 不是我点的。本端提交（beginSubmit → submitting / 乐观 markResolved）、
 * 重放段、journal 水合都不算——认错人比不认更糟。
 */
import {
  applyInteractionWireEvent,
  hydrateInteractionsFromJournal,
  useInteractionStore,
} from "@/stores/interactions";
import { beforeEach, describe, expect, it } from "vitest";

const CID = "c1";
const MID = "m1";

function store() {
  return useInteractionStore.getState();
}

function raiseApproval(id = "a1"): void {
  applyInteractionWireEvent(
    "approval_required",
    { approval_id: id, tool_name: "terminal", arguments: {} },
    CID,
    MID,
    "server",
    { live: true },
  );
}

function resolveApproval(
  id = "a1",
  opts: { live?: boolean } | undefined = { live: true },
): void {
  applyInteractionWireEvent(
    "approval_resolved",
    { approval_id: id, decision: "approve" },
    CID,
    MID,
    "server",
    opts,
  );
}

function raiseEscalation(id: string): void {
  applyInteractionWireEvent(
    "escalation_required",
    { escalation_id: id, question: "用哪个库？", assumption: "Postgres" },
    CID,
    MID,
    "server",
    { live: true },
  );
}

function resolveEscalation(id: string, payload: Record<string, unknown>): void {
  applyInteractionWireEvent(
    "escalation_resolved",
    { escalation_id: id, ...payload },
    CID,
    MID,
    "server",
    { live: true },
  );
}

beforeEach(() => {
  useInteractionStore.setState({ byId: new Map() });
});

describe("settledElsewhere", () => {
  it("本端一直挂着 pending → 实时 resolved = 另一端拍的", () => {
    raiseApproval();
    resolveApproval();

    const entry = store().get("a1");
    expect(entry?.status).toBe("resolved");
    expect(entry?.settledElsewhere).toBe(true);
  });

  it("本端自己提交过（submitting）→ 不认领为另一端", () => {
    raiseApproval();
    expect(store().beginSubmit("a1")).toBe(true);
    resolveApproval();

    expect(store().get("a1")?.settledElsewhere).toBeUndefined();
  });

  it("本端乐观 markResolved 后的 SSE 回声 → 不认领为另一端", () => {
    raiseApproval();
    store().markResolved({ kind: "approval", id: "a1" });
    resolveApproval();

    expect(store().get("a1")?.settledElsewhere).toBeUndefined();
  });

  it("catch-up 重放段（live=false）不认领——重连不该重播旧转折", () => {
    applyInteractionWireEvent(
      "approval_required",
      { approval_id: "a2", tool_name: "terminal", arguments: {} },
      CID,
      MID,
      "server",
      { live: false },
    );
    resolveApproval("a2", { live: false });

    expect(store().get("a2")?.status).toBe("resolved");
    expect(store().get("a2")?.settledElsewhere).toBeUndefined();
  });

  it("journal 水合不认领——上一次会话可能正是本端点的", () => {
    hydrateInteractionsFromJournal(CID, MID, [
      {
        type: "approval_required",
        payload: { approval_id: "a3", tool_name: "terminal", arguments: {} },
      },
      { type: "approval_resolved", payload: { approval_id: "a3" } },
    ]);

    expect(store().get("a3")?.status).toBe("resolved");
    expect(store().get("a3")?.settledElsewhere).toBeUndefined();
  });

  it("没见过 required 就来 resolved（重载边角）→ 无卡可交代，不认领", () => {
    resolveApproval("ghost");

    expect(store().get("ghost")?.status).toBe("resolved");
    expect(store().get("ghost")?.settledElsewhere).toBeUndefined();
  });

  it("升级卡：CEO 裁决的不算——压根没有人拍板", () => {
    raiseEscalation("esc-ceo");
    resolveEscalation("esc-ceo", {
      status: "resolved",
      arbitrated_by: "ceo",
      via_user: false,
    });

    expect(store().get("esc-ceo")?.status).toBe("resolved");
    expect(store().get("esc-ceo")?.settledElsewhere).toBeUndefined();
  });

  it("升级卡：超时 / 按假设推进的不算", () => {
    raiseEscalation("esc-timeout");
    resolveEscalation("esc-timeout", { status: "timed_out", answer: "" });
    raiseEscalation("esc-assumed");
    resolveEscalation("esc-assumed", { status: "assumed", answer: "" });

    expect(store().get("esc-timeout")?.settledElsewhere).toBeUndefined();
    expect(store().get("esc-assumed")?.settledElsewhere).toBeUndefined();
  });

  it("升级卡：另一端的人答的才算", () => {
    raiseEscalation("esc-user");
    resolveEscalation("esc-user", {
      status: "resolved",
      answer: "用 Postgres。",
    });

    expect(store().get("esc-user")?.settledElsewhere).toBe(true);
  });

  it("回执关掉的卡：回执本身不认领处理方", () => {
    raiseEscalation("esc-receipt");
    store().markSettledByReceipt({ kind: "escalation", id: "esc-receipt" });

    const entry = store().get("esc-receipt");
    expect(entry?.status).toBe("resolved");
    expect(entry?.settledByReceipt).toBe(true);
    expect(entry?.settledElsewhere).toBeUndefined();
  });

  it("回执关掉后，归属仍由随后那帧线材来证——人答的算", () => {
    raiseApproval("a-receipt");
    store().markSettledByReceipt({ kind: "approval", id: "a-receipt" });
    resolveApproval("a-receipt");

    expect(store().get("a-receipt")?.settledElsewhere).toBe(true);
  });

  it("回执关掉后，主管仲裁 / 超时那帧照样不算", () => {
    raiseEscalation("esc-receipt-ceo");
    store().markSettledByReceipt({ kind: "escalation", id: "esc-receipt-ceo" });
    resolveEscalation("esc-receipt-ceo", {
      status: "resolved",
      arbitrated_by: "ceo",
    });

    expect(store().get("esc-receipt-ceo")?.settledElsewhere).toBeUndefined();
  });

  it("本端真结掉的卡，回执入口不再改写它", () => {
    raiseApproval("a-mine");
    store().markResolved({
      kind: "approval",
      id: "a-mine",
      resolution: { decision: "approve" },
    });
    store().markSettledByReceipt({ kind: "approval", id: "a-mine" });

    expect(store().get("a-mine")?.settledByReceipt).toBeUndefined();
    expect(store().get("a-mine")?.resolution).toEqual({ decision: "approve" });
  });

  it("冷卡同样适用：另一端放行 checkpoint 也算", () => {
    applyInteractionWireEvent(
      "checkpoint_required",
      { checkpoint_id: "cp1", question: "去哪条路？" },
      CID,
      MID,
      "server",
      { live: true },
    );
    applyInteractionWireEvent(
      "checkpoint_resolved",
      { checkpoint_id: "cp1", decision: "continue" },
      CID,
      MID,
      "server",
      { live: true },
    );

    expect(store().get("cp1")?.settledElsewhere).toBe(true);
  });
});
