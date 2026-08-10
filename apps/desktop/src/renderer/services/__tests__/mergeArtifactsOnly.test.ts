// @vitest-environment jsdom

import type { DeliveryStatusPayload } from "@/types/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/workspace", () => ({
  fetchWorkspaceFileBlob: vi.fn(),
}));

vi.mock("@/services/workspaceHttp", () => ({
  authedFetch: vi.fn(),
  encodePath: (p: string) => encodeURIComponent(p),
}));

vi.mock("@/services/api", () => ({
  BASE_URL: "http://test",
}));

import { bytesToBase64 } from "@/lib/mergeLandingDiff";
import { fetchWorkspaceFileBlob } from "@/services/workspace";
import {
  resolveMergeArtifactRefs,
  writeArtifactsToLanding,
} from "../mergeArtifactsOnly";

const fetchBlob = fetchWorkspaceFileBlob as unknown as ReturnType<typeof vi.fn>;

function status(
  overrides: Partial<DeliveryStatusPayload> &
    Pick<DeliveryStatusPayload, "delivered_files">,
): DeliveryStatusPayload {
  return {
    execution_id: "e1",
    state: "delivered",
    summary: "ok",
    gaps: [],
    actions: [],
    ...overrides,
  };
}

describe("resolveMergeArtifactRefs", () => {
  it("优先取 artifacts accepted", () => {
    expect(
      resolveMergeArtifactRefs(
        status({
          delivered_files: ["legacy.md"],
          artifacts: [
            { path: "ok.md", status: "accepted" },
            { path: "bad.md", status: "rejected", reason: "x" },
          ],
        }),
      ),
    ).toEqual([{ path: "ok.md" }]);
  });

  it("无 accepted 时回退 delivered_files", () => {
    expect(
      resolveMergeArtifactRefs(
        status({
          delivered_files: ["a.md", "b.md"],
          artifacts: [{ path: "bad.md", status: "rejected" }],
        }),
      ),
    ).toEqual([{ path: "a.md" }, { path: "b.md" }]);
  });

  it("缺 artifacts 字段时用 delivered_files", () => {
    expect(
      resolveMergeArtifactRefs(status({ delivered_files: ["only.md"] })),
    ).toEqual([{ path: "only.md" }]);
  });

  it("皆空 → []", () => {
    expect(
      resolveMergeArtifactRefs(status({ delivered_files: [], artifacts: [] })),
    ).toEqual([]);
    expect(resolveMergeArtifactRefs(null)).toEqual([]);
  });
});

describe("writeArtifactsToLanding", () => {
  beforeEach(() => {
    fetchBlob.mockReset();
  });

  afterEach(() => {
    // @ts-expect-error 测试后还原为「无 preload」环境
    window.fsApi = undefined;
  });

  it("有产物：不存在则 write_bytes；已存在则跳过", async () => {
    const payload = bytesToBase64(new TextEncoder().encode("hello"));
    fetchBlob.mockResolvedValue(new Blob([new TextEncoder().encode("hello")]));

    const workspaceOp = vi.fn(
      async (_root: string, op: string, args: { path: string }) => {
        if (op === "exists") {
          return { ok: true, value: args.path === "exists.md" };
        }
        if (op === "write_bytes") {
          return { ok: true, value: null };
        }
        return { ok: false, error: { detail: "unexpected" } };
      },
    );
    window.fsApi = { workspaceOp } as unknown as typeof window.fsApi;

    const summary = await writeArtifactsToLanding({
      conversationId: "c1",
      rootId: "root-1",
      refs: [{ path: "new.md" }, { path: "exists.md" }],
    });

    expect(summary.written).toEqual(["new.md"]);
    expect(summary.skippedExisting).toEqual(["exists.md"]);
    expect(summary.errors).toEqual([]);
    expect(workspaceOp).toHaveBeenCalledWith("root-1", "write_bytes", {
      path: "new.md",
      data: payload,
    });
    expect(workspaceOp).not.toHaveBeenCalledWith(
      "root-1",
      "write_bytes",
      expect.objectContaining({ path: "exists.md" }),
    );
  });
});
