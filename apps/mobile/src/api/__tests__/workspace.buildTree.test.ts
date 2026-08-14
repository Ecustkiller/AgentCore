import { describe, expect, it } from "vitest";
import { buildTree, fileMetaByPath, listingLeafMeta } from "../workspace";

describe("buildTree size/mtime meta", () => {
  it("carries leaf size_bytes / mtime_ms onto file nodes", () => {
    const tree = buildTree([
      {
        path: "docs/a.md",
        is_dir: false,
        size_bytes: 12000,
        mtime_ms: 1_700_000_000_000,
      },
    ]);
    const kids = tree.get("docs") ?? [];
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({
      name: "a.md",
      path: "docs/a.md",
      isDir: false,
      sizeBytes: 12000,
      mtimeMs: 1_700_000_000_000,
    });
    // Synthetic mid-path dir has no meta.
    const roots = tree.get("") ?? [];
    const docs = roots.find((n) => n.name === "docs");
    expect(docs).toMatchObject({ isDir: true });
    expect(docs?.sizeBytes).toBeUndefined();
    expect(docs?.mtimeMs).toBeUndefined();
  });

  it("merges meta when a real dir entry arrives after synthetic mid-path", () => {
    const tree = buildTree([
      {
        path: "docs/a.md",
        is_dir: false,
        size_bytes: 10,
        mtime_ms: 100,
      },
      {
        path: "docs",
        is_dir: true,
        size_bytes: null,
        mtime_ms: 999,
      },
    ]);
    const roots = tree.get("") ?? [];
    const docs = roots.find((n) => n.name === "docs");
    expect(docs).toMatchObject({
      isDir: true,
      mtimeMs: 999,
    });
    expect(docs?.sizeBytes).toBeUndefined();
  });

  it("keeps directory size_bytes undefined when API sends null", () => {
    const tree = buildTree([
      { path: "src", is_dir: true, size_bytes: null, mtime_ms: 50 },
    ]);
    const src = (tree.get("") ?? [])[0];
    expect(src).toMatchObject({ name: "src", isDir: true, mtimeMs: 50 });
    expect(src?.sizeBytes).toBeUndefined();
  });
});

describe("listingLeafMeta / fileMetaByPath", () => {
  it("omits null fields and ignores non-leaf / directory rows", () => {
    expect(listingLeafMeta({ size_bytes: 12, mtime_ms: 99 }, false)).toEqual({
      sizeBytes: undefined,
      mtimeMs: undefined,
    });
    expect(listingLeafMeta({ size_bytes: null, mtime_ms: 99 }, true)).toEqual({
      sizeBytes: undefined,
      mtimeMs: 99,
    });

    const map = fileMetaByPath([
      {
        path: "docs/a.md",
        is_dir: false,
        size_bytes: 12000,
        mtime_ms: 1_700_000_000_000,
      },
      { path: "docs", is_dir: true, size_bytes: null, mtime_ms: 50 },
      { path: "empty.bin", is_dir: false, size_bytes: null, mtime_ms: null },
    ]);
    expect([...map.keys()]).toEqual(["docs/a.md"]);
    expect(map.get("docs/a.md")).toEqual({
      sizeBytes: 12000,
      mtimeMs: 1_700_000_000_000,
    });
  });

  it("keeps a real 0-byte file size", () => {
    const map = fileMetaByPath([
      { path: "empty.txt", is_dir: false, size_bytes: 0, mtime_ms: null },
    ]);
    expect(map.get("empty.txt")).toEqual({
      sizeBytes: 0,
      mtimeMs: undefined,
    });
  });
});
