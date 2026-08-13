import { bucketTree, sortNodes } from "@/components/files/useFileTreeData";
import type { FileNode } from "@/lib/fileSource";
import { describe, expect, it } from "vitest";

const dir = (path: string): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDir: true,
});
const file = (path: string): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDir: false,
});

describe("sortNodes", () => {
  it("目录在前、文件在后，各自按名排", () => {
    const nodes = [file("b.md"), dir("zzz"), file("a.md"), dir("src")];
    expect(sortNodes(nodes).map((n) => n.path)).toEqual([
      "src",
      "zzz",
      "a.md",
      "b.md",
    ]);
  });

  it("盘上 AgentCore/（AI 工作间）沉到同级最后", () => {
    const nodes = [dir("AgentCore"), file("报告.md"), dir("合同")];
    expect(sortNodes(nodes).map((n) => n.path)).toEqual([
      "合同",
      "报告.md",
      "AgentCore",
    ]);
  });

  it("嵌套的同名目录仍按普通目录排", () => {
    const map = bucketTree([
      dir("src"),
      dir("src/AgentCore"),
      file("src/z.ts"),
      dir("AgentCore"),
      file("readme.md"),
    ]);
    expect(map.get("")?.map((n) => n.path)).toEqual([
      "src",
      "readme.md",
      "AgentCore",
    ]);
    expect(map.get("src")?.map((n) => n.path)).toEqual([
      "src/AgentCore",
      "src/z.ts",
    ]);
  });
});
