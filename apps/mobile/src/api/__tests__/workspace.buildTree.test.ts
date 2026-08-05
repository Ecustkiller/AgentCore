import { describe, expect, it } from "vitest";
import { buildTree } from "../workspace";

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
