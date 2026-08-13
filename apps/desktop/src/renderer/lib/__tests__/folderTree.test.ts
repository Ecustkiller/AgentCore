import {
  ancestorFolderIds,
  buildFolderTree,
  childFolderNames,
  folderAncestorNames,
  pruneFolderTree,
  subtreeFolderIds,
} from "@/lib/folderTree";
import type { FolderMeta } from "@/services/folders";
import { describe, expect, it } from "vitest";

/** Cloud folder at `relPath`; the parent prefix is derived the way the server does. */
function cloud(id: string, relPath: string): FolderMeta {
  const cut = relPath.lastIndexOf("/");
  return {
    id,
    name: cut === -1 ? relPath : relPath.slice(cut + 1),
    mode: "cloud",
    localRootId: null,
    localSubpath: null,
    relPath,
    parentRelPath: cut === -1 ? "" : relPath.slice(0, cut),
  };
}

describe("buildFolderTree", () => {
  it("nests by relPath and numbers depth per level", () => {
    const roots = buildFolderTree([
      cloud("f-icon", "设计/图标"),
      cloud("f-design", "设计"),
      cloud("f-deep", "设计/图标/线性"),
    ]);

    expect(roots.map((n) => n.folder.id)).toEqual(["f-design"]);
    const design = roots[0];
    expect(design.depth).toBe(0);
    expect(design.children.map((n) => n.folder.id)).toEqual(["f-icon"]);
    expect(design.children[0].depth).toBe(1);
    expect(design.children[0].children[0].folder.id).toBe("f-deep");
    expect(design.children[0].children[0].depth).toBe(2);
  });

  it("sorts siblings by name at every level", () => {
    const roots = buildFolderTree([
      cloud("f-b", "B"),
      cloud("f-a", "A"),
      cloud("f-a2", "A/乙"),
      cloud("f-a1", "A/甲"),
    ]);
    expect(roots.map((n) => n.folder.name)).toEqual(["A", "B"]);
    expect(roots[0].children.map((n) => n.folder.name)).toEqual(["甲", "乙"]);
  });

  it("surfaces an orphan at top level instead of dropping it", () => {
    // 设计 was filtered out (search, or the list is mid-refresh) — 图标 must still show.
    const roots = buildFolderTree([cloud("f-icon", "设计/图标")]);
    expect(roots.map((n) => n.folder.id)).toEqual(["f-icon"]);
    expect(roots[0].depth).toBe(0);
  });

  it("treats a folder with no relPath as top level (legacy row / local folder)", () => {
    const legacy: FolderMeta = {
      id: "f-old",
      name: "旧文件夹",
      mode: "cloud",
      localRootId: null,
      localSubpath: null,
    };
    const roots = buildFolderTree([legacy, cloud("f-design", "设计")]);
    expect(roots.map((n) => n.folder.id).sort()).toEqual(["f-design", "f-old"]);
  });
});

describe("childFolderNames", () => {
  it("returns the last segment of each direct child so the file tree can hide them", () => {
    const [design] = buildFolderTree([
      cloud("f-design", "设计"),
      cloud("f-icon", "设计/图标"),
      cloud("f-font", "设计/字体"),
      cloud("f-deep", "设计/图标/线性"),
    ]);
    expect(childFolderNames(design).sort()).toEqual(["图标", "字体"]);
  });
});

describe("subtreeFolderIds", () => {
  it("includes the node itself and every descendant", () => {
    const [design] = buildFolderTree([
      cloud("f-design", "设计"),
      cloud("f-icon", "设计/图标"),
      cloud("f-deep", "设计/图标/线性"),
    ]);
    expect(subtreeFolderIds(design).sort()).toEqual([
      "f-deep",
      "f-design",
      "f-icon",
    ]);
  });
});

describe("folderAncestorNames", () => {
  it("reads the breadcrumb outermost first", () => {
    expect(folderAncestorNames(cloud("f", "设计/图标/线性"))).toEqual([
      "设计",
      "图标",
    ]);
    expect(folderAncestorNames(cloud("f", "设计"))).toEqual([]);
  });
});

describe("ancestorFolderIds", () => {
  const folders = [
    cloud("f-design", "设计"),
    cloud("f-icon", "设计/图标"),
    cloud("f-deep", "设计/图标/线性"),
  ];

  it("lists the ids to expand, outermost first", () => {
    expect(ancestorFolderIds(folders, "f-deep")).toEqual([
      "f-design",
      "f-icon",
    ]);
  });

  it("is empty for a top-level folder and for an unknown id", () => {
    expect(ancestorFolderIds(folders, "f-design")).toEqual([]);
    expect(ancestorFolderIds(folders, "missing")).toEqual([]);
  });
});

describe("pruneFolderTree", () => {
  const roots = buildFolderTree([
    cloud("f-design", "设计"),
    cloud("f-icon", "设计/图标"),
    cloud("f-other", "杂项"),
  ]);

  it("keeps ancestors of a deep match so it stays reachable", () => {
    const pruned = pruneFolderTree(roots, (f) => f.id === "f-icon");
    expect(pruned.map((n) => n.folder.id)).toEqual(["f-design"]);
    expect(pruned[0].children.map((n) => n.folder.id)).toEqual(["f-icon"]);
    expect(pruned[0].children[0].depth).toBe(1);
  });

  it("keeps a matching parent without its unmatched children", () => {
    const pruned = pruneFolderTree(roots, (f) => f.id === "f-design");
    expect(pruned.map((n) => n.folder.id)).toEqual(["f-design"]);
    expect(pruned[0].children).toEqual([]);
  });

  it("drops branches with no match at all", () => {
    expect(pruneFolderTree(roots, () => false)).toEqual([]);
  });
});
