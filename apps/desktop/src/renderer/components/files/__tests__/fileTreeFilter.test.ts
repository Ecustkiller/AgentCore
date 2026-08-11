import { bucketTree } from "@/components/files/useFileTreeData";
import type { FileNode } from "@/lib/fileSource";
import { describe, expect, it } from "vitest";
import {
  computeFileTreeFilter,
  matchesFileTreeQuery,
} from "../fileTreeFilter";

function childrenFrom(nodes: FileNode[]) {
  const map = bucketTree(nodes);
  return (dir: string) => map.get(dir);
}

describe("matchesFileTreeQuery", () => {
  it("空 query 全匹配", () => {
    expect(
      matchesFileTreeQuery({ name: "a.txt", path: "a.txt" }, "  "),
    ).toBe(true);
  });

  it("大小写不敏感匹配文件名", () => {
    expect(
      matchesFileTreeQuery({ name: "ReadMe.md", path: "docs/ReadMe.md" }, "readme"),
    ).toBe(true);
  });

  it("匹配相对路径片段", () => {
    expect(
      matchesFileTreeQuery(
        { name: "a.ts", path: "src/utils/a.ts" },
        "utils/a",
      ),
    ).toBe(true);
  });

  it("中文路径可用", () => {
    expect(
      matchesFileTreeQuery(
        { name: "说明.md", path: "文档/说明.md" },
        "说明",
      ),
    ).toBe(true);
    expect(
      matchesFileTreeQuery(
        { name: "说明.md", path: "文档/说明.md" },
        "文档",
      ),
    ).toBe(true);
  });
});

describe("computeFileTreeFilter", () => {
  const nodes: FileNode[] = [
    { name: "src", path: "src", isDir: true },
    { name: "utils", path: "src/utils", isDir: true },
    { name: "a.ts", path: "src/utils/a.ts", isDir: false },
    { name: "b.ts", path: "src/utils/b.ts", isDir: false },
    { name: "readme.md", path: "readme.md", isDir: false },
    { name: "文档", path: "文档", isDir: true },
    { name: "说明.md", path: "文档/说明.md", isDir: false },
  ];

  it("空 query 返回空集合（调用方视为不过滤）", () => {
    const r = computeFileTreeFilter(childrenFrom(nodes), "");
    expect(r.visible.size).toBe(0);
    expect(r.forceExpand.size).toBe(0);
  });

  it("匹配文件可见且强制展开祖先", () => {
    const r = computeFileTreeFilter(childrenFrom(nodes), "a.ts");
    expect(r.visible.has("src/utils/a.ts")).toBe(true);
    expect(r.visible.has("src/utils")).toBe(true);
    expect(r.visible.has("src")).toBe(true);
    expect(r.visible.has("src/utils/b.ts")).toBe(false);
    expect(r.visible.has("readme.md")).toBe(false);
    expect(r.forceExpand.has("src")).toBe(true);
    expect(r.forceExpand.has("src/utils")).toBe(true);
  });

  it("清空语义：无匹配时 visible 为空", () => {
    const r = computeFileTreeFilter(childrenFrom(nodes), "zzz-nope");
    expect(r.visible.size).toBe(0);
  });

  it("文件夹名匹配时自身可见", () => {
    const r = computeFileTreeFilter(childrenFrom(nodes), "utils");
    expect(r.visible.has("src/utils")).toBe(true);
    expect(r.visible.has("src")).toBe(true);
    expect(r.forceExpand.has("src")).toBe(true);
  });
});
