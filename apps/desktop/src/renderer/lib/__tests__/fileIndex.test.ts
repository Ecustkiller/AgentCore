import type { FileSource } from "@/lib/fileSource";
import { describe, expect, it } from "vitest";
import {
  type IndexedEntry,
  filterEntries,
  isEmptyStateEligible,
  loadFileIndex,
  mentionFilterTotal,
  normalizeFileIndexListing,
} from "../fileIndex";

function entry(
  relPath: string,
  patch: Partial<IndexedEntry> = {},
): IndexedEntry {
  const name = relPath.split("/").pop() ?? relPath;
  return {
    sourceId: "local:r",
    sourceLabel: "Demo",
    relPath,
    name,
    display: `Demo/${relPath}`,
    kind: "file",
    ...patch,
  };
}

describe("filterEntries 空态排序", () => {
  it("最近使用优先于最近修改，再浅层", () => {
    const items = [
      entry("old.ts", { mtimeMs: 10 }),
      entry("used.ts", { mtimeMs: 1, lastUsedAt: 90 }),
      entry("new.ts", { mtimeMs: 50 }),
      entry("src/lib.ts", { mtimeMs: 80 }),
    ];
    expect(filterEntries(items, "", 10).map((e) => e.relPath)).toEqual([
      "used.ts",
      "src/lib.ts",
      "new.ts",
      "old.ts",
    ]);
  });
});

describe("filterEntries 浅层优先", () => {
  it("空态只出 1–2 层，深层不进列表", () => {
    const items = [
      entry("README.md"),
      entry("src/index.ts"),
      entry("src/lib/util.ts"),
      entry("a/b/c/d.ts"),
    ];
    expect(filterEntries(items, "", 10).map((e) => e.relPath)).toEqual([
      "README.md",
      "src/index.ts",
    ]);
    expect(isEmptyStateEligible(entry("src/lib/util.ts"))).toBe(false);
  });
});

describe("filterEntries 点路径折叠", () => {
  it("空态隐藏点路径，搜索词能命中", () => {
    const items = [
      entry("src/app.ts"),
      entry(".cursor/rules/foo.mdc"),
      entry(".gitignore"),
      entry("src/.env"),
    ];
    expect(filterEntries(items, "", 10).map((e) => e.relPath)).toEqual([
      "src/app.ts",
    ]);
    expect(filterEntries(items, "cursor", 10).map((e) => e.relPath)).toEqual([
      ".cursor/rules/foo.mdc",
    ]);
    expect(filterEntries(items, "gitignore", 10).map((e) => e.relPath)).toEqual(
      [".gitignore"],
    );
    expect(mentionFilterTotal(items, "")).toBe(1);
    expect(mentionFilterTotal(items, "env")).toBe(1);
  });
});

describe("normalizeFileIndexListing", () => {
  it("只认 { files, truncated }，并收下 mtime", () => {
    const rich = normalizeFileIndexListing({
      truncated: true,
      files: [
        { relPath: "new.ts", mtimeMs: 20 },
        { relPath: "old.ts", mtimeMs: 5 },
        { relPath: "" },
      ],
    });
    expect(rich.truncated).toBe(true);
    expect(rich.items).toEqual([
      { relPath: "new.ts", mtimeMs: 20 },
      { relPath: "old.ts", mtimeMs: 5 },
    ]);
  });
});

describe("loadFileIndex", () => {
  it("从对象清单收下 mtime，目录取子文件最新", async () => {
    const source = {
      id: "local:r",
      label: "Demo",
      listFileIndex: async () => ({
        files: [
          { relPath: "src/a.ts", mtimeMs: 10 },
          { relPath: "src/b.ts", mtimeMs: 40 },
        ],
        truncated: false,
      }),
    } as FileSource;
    const index = await loadFileIndex([source]);
    expect(index.truncated).toBe(false);
    expect(index.files.map((f) => [f.relPath, f.mtimeMs])).toEqual([
      ["src/a.ts", 10],
      ["src/b.ts", 40],
    ]);
    expect(index.dirs).toEqual([
      expect.objectContaining({ relPath: "src", kind: "dir", mtimeMs: 40 }),
    ]);
  });

  it("透出 truncated", async () => {
    const source = {
      id: "local:r",
      label: "Demo",
      listFileIndex: async () => ({
        files: [{ relPath: "a.ts", mtimeMs: 10 }],
        truncated: true,
      }),
    } as FileSource;
    const index = await loadFileIndex([source]);
    expect(index.truncated).toBe(true);
  });
});
