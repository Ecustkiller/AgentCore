// @vitest-environment jsdom

import type { ReviewRow } from "@/lib/handoff-review";
import { bytesToBase64, sha256HexFromBytes } from "@/lib/mergeLandingDiff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/workspace", () => ({
  createSnapshot: vi.fn(async () => ({
    snapshotId: "snap-1",
    sizeBytes: 10,
  })),
}));

vi.mock("@/services/workspaceHttp", () => ({
  BASE_URL: "http://test",
  authedFetch: vi.fn(),
}));

vi.mock("@/services/handoff", () => ({
  readLocalShas: vi.fn(),
}));

import { readLocalShas } from "@/services/handoff";
import { authedFetch } from "@/services/workspaceHttp";
import JSZip from "jszip";
import {
  applyMergeLandingDiff,
  prepareMergeLandingDiff,
} from "../mergeLandingDiff";

const fetchMock = authedFetch as unknown as ReturnType<typeof vi.fn>;
const shasMock = readLocalShas as unknown as ReturnType<typeof vi.fn>;

describe("mergeLandingDiff service · 编排", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    shasMock.mockReset();
  });

  afterEach(() => {
    // @ts-expect-error 测试后还原为「无 preload」环境
    window.fsApi = undefined;
  });

  it("prepare：云 zip 与落点 sha 合成评审行", async () => {
    const zip = new JSZip();
    zip.file("only-cloud.txt", "hello");
    zip.file("conflict.txt", "cloud");
    const buf = await zip.generateAsync({ type: "arraybuffer" });
    fetchMock.mockResolvedValue({
      blob: async () => new Blob([buf]),
    });

    const cloudConflict = new TextEncoder().encode("cloud");
    const conflictSha = await sha256HexFromBytes(cloudConflict);
    shasMock.mockResolvedValue(
      new Map<string, string | null>([
        ["only-cloud.txt", null],
        ["conflict.txt", "local-other"],
      ]),
    );

    window.fsApi = {
      workspaceOp: vi.fn(async () => ({ ok: true, value: false })),
    } as unknown as typeof window.fsApi;

    const prepared = await prepareMergeLandingDiff("c1", "root-1", "desk");
    expect(
      prepared.rows.map((r) => [r.change.path, r.verdict, r.decision]),
    ).toEqual([
      ["only-cloud.txt", "clean", "cloud"],
      ["conflict.txt", "conflict", "local"],
    ]);
    expect(prepared.bytesByPath["only-cloud.txt"]).toBeTruthy();
    expect(
      prepared.rows.find((r) => r.change.path === "conflict.txt")?.change
        .resultSha,
    ).toBe(conflictSha);
  });

  it("apply：写前冲突未 force 不覆盖；选云端则 write_bytes", async () => {
    const payload = bytesToBase64(new TextEncoder().encode("cloud"));
    const rows: ReviewRow[] = [
      {
        change: {
          path: "keep.txt",
          changeType: "modified",
          baseSha: null,
          resultSha: "r1",
          isBinary: false,
          content: "cloud",
          sizeBytes: 5,
        },
        localSha: "x",
        verdict: "conflict",
        decision: "local",
      },
      {
        change: {
          path: "take.txt",
          changeType: "added",
          baseSha: null,
          resultSha: "r2",
          isBinary: false,
          content: "cloud",
          sizeBytes: 5,
        },
        localSha: null,
        verdict: "clean",
        decision: "cloud",
      },
    ];

    const workspaceOp = vi.fn(async (_root: string, op: string) => {
      if (op === "write_bytes") return { ok: true, value: 5 };
      return { ok: true, value: null };
    });
    window.fsApi = { workspaceOp } as unknown as typeof window.fsApi;

    shasMock.mockResolvedValue(
      new Map<string, string | null>([
        ["keep.txt", "x"],
        ["take.txt", null],
      ]),
    );

    const summary = await applyMergeLandingDiff("root-1", rows, {
      "take.txt": payload,
    });

    expect(summary.applied).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.conflicts).toBe(0);
    expect(workspaceOp).toHaveBeenCalledWith("root-1", "write_bytes", {
      path: "take.txt",
      data: payload,
    });
    expect(workspaceOp).not.toHaveBeenCalledWith(
      "root-1",
      "write_bytes",
      expect.objectContaining({ path: "keep.txt" }),
    );
  });

  it("apply：评审后落点变冲突且未 force → conflict 不写", async () => {
    const rows: ReviewRow[] = [
      {
        change: {
          path: "race.txt",
          changeType: "added",
          baseSha: null,
          resultSha: "r",
          isBinary: false,
          content: null,
          sizeBytes: 1,
        },
        localSha: null,
        verdict: "clean",
        decision: "cloud",
      },
    ];
    const workspaceOp = vi.fn();
    window.fsApi = { workspaceOp } as unknown as typeof window.fsApi;
    shasMock.mockResolvedValue(new Map([["race.txt", "changed-since-review"]]));

    const summary = await applyMergeLandingDiff("root-1", rows, {
      "race.txt": bytesToBase64(new Uint8Array([1])),
    });
    expect(summary.conflicts).toBe(1);
    expect(workspaceOp).not.toHaveBeenCalled();
  });
});
