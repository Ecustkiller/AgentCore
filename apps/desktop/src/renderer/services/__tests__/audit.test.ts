import { ApiError } from "@/services/api";
import {
  fetchFileAudit,
  fetchTurnAudit,
  groupAuditCountsByRun,
} from "@/services/audit";
import type { AgentAuditEvent } from "@agentcore/contract-rest-types/audit";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
    },
  };
});

const { api } = await import("@/services/api");

function ev(
  partial: Partial<AgentAuditEvent> & Pick<AgentAuditEvent, "id">,
): AgentAuditEvent {
  return {
    turn_id: "turn-1",
    trace_id: null,
    execution_id: null,
    run_id: null,
    parent_run_id: null,
    seq: 1,
    category: "tool",
    action: "tool.file_write",
    actor_kind: "member",
    target_type: "file",
    target_ref: "out.txt",
    outcome: "ok",
    detail: {},
    created_at: "2026-07-06T00:00:00Z",
    ...partial,
  };
}

describe("groupAuditCountsByRun", () => {
  it("groups events by run_id and skips null run_id", () => {
    const counts = groupAuditCountsByRun([
      ev({ id: "1", run_id: "run-a" }),
      ev({ id: "2", run_id: "run-a" }),
      ev({ id: "3", run_id: "run-b" }),
      ev({ id: "4", run_id: null }),
    ]);
    expect(counts).toEqual({ "run-a": 2, "run-b": 1 });
  });

  it("returns empty object for no events", () => {
    expect(groupAuditCountsByRun([])).toEqual({});
  });
});

describe("fetchFileAudit", () => {
  it("returns null on 404", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new ApiError(404, "{}"));
    await expect(fetchFileAudit("conv-1", "src/a.ts")).resolves.toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    const err = new ApiError(500, "{}");
    vi.mocked(api.get).mockRejectedValueOnce(err);
    await expect(fetchFileAudit("conv-1", "src/a.ts")).rejects.toBe(err);
  });

  it("encodes path in query string", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [], total: 0 });
    await fetchFileAudit("conv-1", "a b/文件.ts");
    expect(api.get).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/audit/file?path=a%20b%2F%E6%96%87%E4%BB%B6.ts",
    );
  });
});

describe("fetchTurnAudit", () => {
  it("hits the turn-scoped audit endpoint", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [], total: 0 });
    await fetchTurnAudit("conv-1", "msg-1");
    expect(api.get).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/messages/msg-1/audit",
    );
  });
});
