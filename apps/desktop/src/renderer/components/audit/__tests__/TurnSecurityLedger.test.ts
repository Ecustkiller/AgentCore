import { bucketSecurityLedger } from "@/components/audit/TurnSecurityLedger";
import type { AgentAuditEvent } from "@/services/audit";
import { describe, expect, it } from "vitest";

function ev(
  partial: Partial<AgentAuditEvent> &
    Pick<AgentAuditEvent, "id" | "action" | "category">,
): AgentAuditEvent {
  return {
    turn_id: "t1",
    trace_id: null,
    execution_id: null,
    run_id: null,
    parent_run_id: null,
    seq: 0,
    actor_kind: "system",
    target_type: null,
    target_ref: null,
    outcome: "ok",
    detail: {},
    created_at: "2026-07-14T10:00:00Z",
    ...partial,
  };
}

describe("bucketSecurityLedger", () => {
  it("groups writes / runs / approvals / presets", () => {
    const buckets = bucketSecurityLedger([
      ev({
        id: "1",
        category: "permission",
        action: "permission.preset_snapshot",
        detail: { permission_preset: "full_trust" },
      }),
      ev({
        id: "2",
        category: "tool",
        action: "tool.file_write",
        target_type: "file",
        target_ref: "a.md",
      }),
      ev({
        id: "3",
        category: "tool",
        action: "tool.code_execute",
      }),
      ev({
        id: "4",
        category: "approval",
        action: "approval.granted",
        detail: { tool_name: "file_write", decided_by: "user" },
      }),
    ]);
    expect(buckets.presetInForce).toBe("full_trust");
    expect(buckets.presets).toHaveLength(1);
    expect(buckets.writes).toHaveLength(1);
    expect(buckets.runs).toHaveLength(1);
    expect(buckets.approvals).toHaveLength(1);
  });
});
