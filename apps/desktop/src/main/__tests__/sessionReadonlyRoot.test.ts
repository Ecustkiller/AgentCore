/**
 * W3 session readonly root helpers (pathGuard algorithm unchanged).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { executeWorkspaceOp } from "../fs/workspace/dispatch";
import { buildExternalEnvFromRoots } from "../fs/workspace/exec";
import type { StoredRoot } from "../fs/roots";

const readonlyRoot: StoredRoot = {
  id: "s1",
  name: "reports",
  absPath: "C:\\tmp\\reports",
  sessionOnly: true,
  conversationId: "c1",
  readonly: true,
  alias: "reports",
};

describe("session readonly root write refusal", () => {
  it("rejects file write ops on readonly roots", async () => {
    const r = await executeWorkspaceOp(readonlyRoot, "write", {
      path: "a.txt",
      content: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("OutsideWorkspace");
      expect(r.error.detail).toContain("只读");
    }
  });

  it.each(["execute", "process_start", "archive"] as const)(
    "rejects %s on readonly roots",
    async (op) => {
      const r = await executeWorkspaceOp(readonlyRoot, op, {});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("OutsideWorkspace");
        expect(r.error.detail).toContain("只读");
      }
    },
  );
});

describe("buildExternalEnvFromRoots conversation ownership", () => {
  const grant: StoredRoot = {
    id: "ext-1",
    name: "reports",
    absPath: "C:\\data\\reports",
    sessionOnly: true,
    conversationId: "c1",
    readonly: true,
    alias: "reports",
  };
  const otherConv: StoredRoot = {
    ...grant,
    id: "ext-2",
    conversationId: "c-other",
  };
  const permanent: StoredRoot = {
    id: "perm-1",
    name: "proj",
    absPath: "C:\\data\\proj",
  };

  const lookup = (id: string) =>
    ({ "ext-1": grant, "ext-2": otherConv, "perm-1": permanent })[id];

  it("injects only matching sessionOnly grants for the conversation", () => {
    const env = buildExternalEnvFromRoots(
      { reports: "ext-1", other: "ext-2", proj: "perm-1" },
      "c1",
      lookup,
    );
    expect(env).toEqual({ AGENTCORE_EXTERNAL_REPORTS: "C:\\data\\reports" });
  });

  it("skips injection when conversation_id is empty", () => {
    const env = buildExternalEnvFromRoots({ reports: "ext-1" }, "", lookup);
    expect(env).toEqual({});
  });
});
