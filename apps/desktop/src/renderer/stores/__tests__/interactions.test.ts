import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyInteractionWireEvent,
  useInteractionStore,
} from "../interactions";

const store = () => useInteractionStore.getState();

beforeEach(() => {
  store().clear();
});

describe("InteractionStore", () => {
  it("upserts required payloads for all hot/cold kinds", () => {
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: {
        approval_id: "a1",
        tool_name: "file_write",
        arguments: {},
      },
    });
    store().upsertRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp1", question: "继续吗？" },
    });
    expect(store().get("a1")?.status).toBe("pending");
    expect(store().get("cp1")?.kind).toBe("ask_user");
    expect(store().listPending("c1")).toHaveLength(2);
  });

  it("ignores duplicate required for an already-resolved id", () => {
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: { approval_id: "a1", tool_name: "x", arguments: {} },
    });
    store().markResolved({ kind: "approval", id: "a1" });
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: { approval_id: "a1", tool_name: "y", arguments: {} },
    });
    expect(store().get("a1")?.status).toBe("resolved");
    expect(
      (store().get("a1")?.payload as { tool_name?: string }).tool_name,
    ).toBe("x");
  });

  it("beginSubmit / reopen / markOrphaned lifecycle", () => {
    store().upsertRequired({
      kind: "escalation",
      conversationId: "c1",
      messageId: "m1",
      payload: { escalation_id: "e1", question: "q", assumption: "a" },
    });
    expect(store().beginSubmit("e1")).toBe(true);
    expect(store().get("e1")?.status).toBe("submitting");
    expect(store().beginSubmit("e1")).toBe(false);
    store().reopen("e1");
    expect(store().get("e1")?.status).toBe("pending");
    store().markOrphaned("e1");
    expect(store().get("e1")?.status).toBe("orphaned");
  });

  it("orphanConversation flips only hot pending cards", () => {
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: { approval_id: "a1", tool_name: "x", arguments: {} },
    });
    store().upsertRequired({
      kind: "ask_user",
      conversationId: "c1",
      messageId: "m1",
      payload: { checkpoint_id: "cp1", question: "q" },
    });
    store().upsertRequired({
      kind: "approval",
      conversationId: "c2",
      messageId: "m2",
      payload: { approval_id: "a2", tool_name: "x", arguments: {} },
    });
    store().orphanConversation("c1", true);
    expect(store().get("a1")?.status).toBe("orphaned");
    expect(store().get("cp1")?.status).toBe("pending");
    expect(store().get("a2")?.status).toBe("pending");
  });

  it("hydratePending replaces pending set for a conversation", () => {
    store().upsertRequired({
      kind: "approval",
      conversationId: "c1",
      messageId: "m1",
      payload: { approval_id: "old", tool_name: "x", arguments: {} },
    });
    store().hydratePending("c1", [
      {
        kind: "delegation_authorization",
        id: "d1",
        messageId: "m9",
        payload: {
          authorization_id: "d1",
          execution_id: "ex1",
          workers: [],
          tools: ["file_write"],
        },
      },
    ]);
    expect(store().get("old")).toBeUndefined();
    expect(store().get("d1")?.status).toBe("pending");
    expect(store().get("d1")?.kind).toBe("delegation_authorization");
  });

  it("applyInteractionWireEvent handles orphaned + required + resolved", () => {
    applyInteractionWireEvent(
      "approval_required",
      {
        approval_id: "a1",
        conversation_id: "c1",
        tool_call_id: "t1",
        tool_name: "file_write",
        arguments: {},
      },
      "c1",
      "m1",
    );
    expect(store().get("a1")?.status).toBe("pending");
    applyInteractionWireEvent(
      "approval_resolved",
      { approval_id: "a1", decision: "approve" },
      "c1",
      "m1",
    );
    expect(store().get("a1")?.status).toBe("resolved");

    applyInteractionWireEvent(
      "escalation_required",
      { escalation_id: "e1", question: "q", assumption: "a" },
      "c1",
      "m1",
    );
    applyInteractionWireEvent(
      "interaction_orphaned",
      { interaction_id: "e1", kind: "escalation" },
      "c1",
      "m1",
    );
    expect(store().get("e1")?.status).toBe("orphaned");
  });
});

describe("escalation_resolved id matching (project frame)", () => {
  it("is covered by InteractionStore markResolved by escalation_id", () => {
    // The project.ts fix matches by f.escalationId; store path uses the same id field.
    applyInteractionWireEvent(
      "escalation_required",
      { escalation_id: "esc-b", question: "B?", assumption: "b" },
      "c1",
      "m1",
    );
    applyInteractionWireEvent(
      "escalation_required",
      { escalation_id: "esc-a", question: "A?", assumption: "a" },
      "c1",
      "m1",
    );
    applyInteractionWireEvent(
      "escalation_resolved",
      { escalation_id: "esc-a", status: "resolved", answer: "yes" },
      "c1",
      "m1",
    );
    expect(store().get("esc-a")?.status).toBe("resolved");
    expect(store().get("esc-b")?.status).toBe("pending");
  });
});

// silence unused vi in case of future mocks
void vi;
