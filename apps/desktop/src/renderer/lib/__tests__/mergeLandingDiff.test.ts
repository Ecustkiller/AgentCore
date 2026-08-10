import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { HandoffApplySelection } from "../handoff-review";
import {
  MERGE_LANDING_FILE_MAX_BYTES,
  buildMergeLandingRows,
  bytesToBase64,
  gateMergeWrite,
  normalizeZipPath,
  parseCloudZip,
  sha256HexFromBytes,
} from "../mergeLandingDiff";

describe("mergeLandingDiff · 无 base 分类", () => {
  it("云有∩落点无 → clean；同内容 → applied；异内容 → conflict 默认留本地", async () => {
    const cloud = new TextEncoder().encode("cloud-v");
    const sha = await sha256HexFromBytes(cloud);
    const files = [
      {
        path: "new.txt",
        resultSha: sha,
        sizeBytes: cloud.byteLength,
        isBinary: false,
        content: "cloud-v",
        contentBase64: bytesToBase64(cloud),
      },
      {
        path: "same.txt",
        resultSha: sha,
        sizeBytes: cloud.byteLength,
        isBinary: false,
        content: "cloud-v",
        contentBase64: bytesToBase64(cloud),
      },
      {
        path: "diff.txt",
        resultSha: sha,
        sizeBytes: cloud.byteLength,
        isBinary: false,
        content: "cloud-v",
        contentBase64: bytesToBase64(cloud),
      },
    ];
    const local = new Map<string, string | null>([
      ["same.txt", sha],
      ["diff.txt", "deadbeef"],
    ]);
    const rows = buildMergeLandingRows(files, local);
    expect(rows.map((r) => [r.change.path, r.verdict, r.decision])).toEqual([
      ["new.txt", "clean", "cloud"],
      ["same.txt", "applied", "cloud"],
      ["diff.txt", "conflict", "local"],
    ]);
    expect(rows[0]?.change.changeType).toBe("added");
    expect(rows[2]?.change.changeType).toBe("modified");
    expect(rows[0]?.change.baseSha).toBeNull();
  });
});

describe("mergeLandingDiff · parseCloudZip", () => {
  it("解析条目并跳过超大文件", async () => {
    const zip = new JSZip();
    zip.file("ok.txt", "hello");
    zip.file("big.bin", new Uint8Array(MERGE_LANDING_FILE_MAX_BYTES + 1));
    const buf = await zip.generateAsync({ type: "arraybuffer" });
    const parsed = await parseCloudZip(buf);
    expect(parsed.files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(parsed.skippedOversized).toEqual(["big.bin"]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.files[0]?.content).toBe("hello");
  });

  it("normalizeZipPath 拒绝穿越与空段", () => {
    expect(normalizeZipPath("a/b.txt")).toBe("a/b.txt");
    expect(normalizeZipPath("../evil.txt")).toBeNull();
    expect(normalizeZipPath("foo/../evil.txt")).toBeNull();
    expect(normalizeZipPath("/abs.txt")).toBe("abs.txt");
  });
});

describe("mergeLandingDiff · gateMergeWrite 禁静默覆盖", () => {
  const sel = (
    over: Partial<HandoffApplySelection> & { path: string },
  ): HandoffApplySelection => ({
    path: over.path,
    decision: over.decision ?? "cloud",
    localSha: over.localSha ?? null,
    force: over.force ?? false,
  });

  it("保留本机 / 已一致 / 新冲突分别 skip 或 conflict", () => {
    expect(
      gateMergeWrite({
        selection: sel({ path: "a", decision: "local" }),
        resultSha: "r",
        freshLocalSha: "x",
      }),
    ).toBe("skip_local");
    expect(
      gateMergeWrite({
        selection: sel({ path: "a", decision: "cloud" }),
        resultSha: "r",
        freshLocalSha: "r",
      }),
    ).toBe("skip_applied");
    expect(
      gateMergeWrite({
        selection: sel({ path: "a", decision: "cloud", force: false }),
        resultSha: "r",
        freshLocalSha: "x",
      }),
    ).toBe("conflict");
  });

  it("冲突行显式选云端（force）允许写入", () => {
    expect(
      gateMergeWrite({
        selection: sel({ path: "a", decision: "cloud", force: true }),
        resultSha: "r",
        freshLocalSha: "x",
      }),
    ).toBe("write");
  });

  it("干净新增可写", () => {
    expect(
      gateMergeWrite({
        selection: sel({ path: "a", decision: "cloud" }),
        resultSha: "r",
        freshLocalSha: null,
      }),
    ).toBe("write");
  });
});
