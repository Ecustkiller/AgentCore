import { beforeEach, describe, expect, it } from "vitest";
import { autoApproveSiblings } from "../../services/approvals";
import type { ApprovalRequiredPayload } from "../../types/events";
import { type PendingApproval, useApprovalStore } from "../approvals";

const payload = (
  over: Partial<ApprovalRequiredPayload> = {},
): ApprovalRequiredPayload => ({
  approval_id: "a1",
  conversation_id: "conv-1",
  tool_call_id: "a1",
  tool_name: "file_write",
  arguments: { path: "a.txt" },
  ...over,
});

const store = () => useApprovalStore.getState();

beforeEach(() => store().clear());

describe("approval store", () => {
  it("maps a wire payload into a pending card", () => {
    store().add(payload());
    expect(store().pending).toHaveLength(1);
    const p = store().pending[0];
    expect(p.approvalId).toBe("a1");
    expect(p.toolName).toBe("file_write");
    expect(p.arguments).toEqual({ path: "a.txt" });
    expect(p.resolving).toBe(false);
  });

  it("ignores a re-delivered event for an id already pending", () => {
    store().add(payload());
    store().add(payload({ tool_name: "code_execute" }));
    expect(store().pending).toHaveLength(1);
    expect(store().pending[0].toolName).toBe("file_write");
  });

  it("removes by id and clears, both idempotent", () => {
    store().add(payload({ approval_id: "a1", tool_call_id: "a1" }));
    store().add(payload({ approval_id: "a2", tool_call_id: "a2" }));
    store().remove("a1");
    expect(store().pending.map((p) => p.approvalId)).toEqual(["a2"]);
    store().remove("a1"); // already gone — no throw, no change
    expect(store().pending).toHaveLength(1);
    store().clear();
    expect(store().pending).toHaveLength(0);
  });

  it("toggles the in-flight flag on one card", () => {
    store().add(payload());
    store().setResolving("a1", true);
    expect(store().pending[0].resolving).toBe(true);
    store().setResolving("a1", false);
    expect(store().pending[0].resolving).toBe(false);
  });

  it("clears only one conversation's cards, omitting the id wipes all", () => {
    store().add(payload({ approval_id: "a1", conversation_id: "conv-1" }));
    store().add(payload({ approval_id: "a2", conversation_id: "conv-2" }));
    // A turn boundary on conv-1 must not touch conv-2's pending prompt.
    store().clear("conv-1");
    expect(store().pending.map((p) => p.approvalId)).toEqual(["a2"]);
    store().clear();
    expect(store().pending).toHaveLength(0);
  });
});

const card = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  approvalId: "a1",
  conversationId: "conv-1",
  toolCallId: "a1",
  toolName: "file_write",
  arguments: {},
  resolving: false,
  ...over,
});

describe("autoApproveSiblings (本轮内都允许 batch放行)", () => {
  it("returns the other pending cards for the same tool", () => {
    const self = card({ approvalId: "a1", toolName: "file_write" });
    const pending = [
      self,
      card({ approvalId: "a2", toolName: "file_write" }),
      card({ approvalId: "a3", toolName: "file_write" }),
    ];
    expect(
      autoApproveSiblings(pending, self, "approve_always").map(
        (p) => p.approvalId,
      ),
    ).toEqual(["a2", "a3"]);
  });

  it("excludes itself, other tools, and cards already in flight", () => {
    const self = card({ approvalId: "a1", toolName: "file_write" });
    const pending = [
      self,
      card({ approvalId: "a2", toolName: "code_execute" }),
      card({ approvalId: "a3", toolName: "file_write", resolving: true }),
      card({ approvalId: "a4", toolName: "file_write" }),
    ];
    expect(
      autoApproveSiblings(pending, self, "approve_always").map(
        (p) => p.approvalId,
      ),
    ).toEqual(["a4"]);
  });

  it("excludes a same-tool card from another conversation", () => {
    // A 本轮内都允许 grant is scoped to one conversation's turn — it must not
    // silently approve another conversation's identical tool call.
    const self = card({ approvalId: "a1", conversationId: "conv-1" });
    const pending = [
      self,
      card({ approvalId: "a2", conversationId: "conv-1" }),
      card({ approvalId: "a3", conversationId: "conv-2" }),
    ];
    expect(
      autoApproveSiblings(pending, self, "approve_always").map(
        (p) => p.approvalId,
      ),
    ).toEqual(["a2"]);
  });

  it("one-shot approve / deny sweep nothing", () => {
    const self = card({ approvalId: "a1", toolName: "file_write" });
    const pending = [self, card({ approvalId: "a2", toolName: "file_write" })];
    expect(autoApproveSiblings(pending, self, "approve")).toEqual([]);
    expect(autoApproveSiblings(pending, self, "deny")).toEqual([]);
  });
});

describe("autoApproveSiblings (本轮内允许所有文件改动 class放行)", () => {
  it("sweeps the whole file-mutation class, not just the same tool", () => {
    // Clicking the class grant on a file_write card also clears str_replace /
    // file_delete / file_move siblings — the one click a mixed-op task needs.
    const self = card({ approvalId: "a1", toolName: "file_write" });
    const pending = [
      self,
      card({ approvalId: "a2", toolName: "str_replace" }),
      card({ approvalId: "a3", toolName: "file_delete" }),
      card({ approvalId: "a4", toolName: "file_move" }),
    ];
    expect(
      autoApproveSiblings(pending, self, "approve_always_files").map(
        (p) => p.approvalId,
      ),
    ).toEqual(["a2", "a3", "a4"]);
  });

  it("leaves code_execute (outside the class) gated", () => {
    const self = card({ approvalId: "a1", toolName: "file_write" });
    const pending = [
      self,
      card({ approvalId: "a2", toolName: "str_replace" }),
      card({ approvalId: "a3", toolName: "code_execute" }),
    ];
    expect(
      autoApproveSiblings(pending, self, "approve_always_files").map(
        (p) => p.approvalId,
      ),
    ).toEqual(["a2"]);
  });

  it("stays scoped to the card's conversation", () => {
    const self = card({ approvalId: "a1", conversationId: "conv-1" });
    const pending = [
      self,
      card({ approvalId: "a2", toolName: "str_replace", conversationId: "conv-1" }),
      card({ approvalId: "a3", toolName: "str_replace", conversationId: "conv-2" }),
    ];
    expect(
      autoApproveSiblings(pending, self, "approve_always_files").map(
        (p) => p.approvalId,
      ),
    ).toEqual(["a2"]);
  });
});
