import {
  baseName,
  entryNameError,
  isInsideDir,
  joinPath,
  moveTargetError,
  parentDir,
} from "@/components/fileBrowser/paths";
import { describe, expect, it } from "vitest";

describe("path arithmetic", () => {
  it("joins against the root without a leading slash", () => {
    expect(joinPath("", "a.md")).toBe("a.md");
    expect(joinPath("docs", "a.md")).toBe("docs/a.md");
    expect(joinPath("docs/notes", "a.md")).toBe("docs/notes/a.md");
  });

  it("reads the parent dir and base name", () => {
    expect(parentDir("a.md")).toBe("");
    expect(parentDir("docs/a.md")).toBe("docs");
    expect(parentDir("docs/notes/a.md")).toBe("docs/notes");
    expect(baseName("docs/notes/a.md")).toBe("a.md");
    expect(baseName("a.md")).toBe("a.md");
  });

  it("treats the root as containing everything", () => {
    expect(isInsideDir("docs/a.md", "")).toBe(true);
    expect(isInsideDir("docs/a.md", "docs")).toBe(true);
    expect(isInsideDir("docs", "docs")).toBe(true);
    expect(isInsideDir("docsx/a.md", "docs")).toBe(false);
  });
});

describe("entryNameError", () => {
  it("accepts ordinary names (spaces / dots / CJK included)", () => {
    expect(entryNameError("笔记 v2.md")).toBeNull();
    expect(entryNameError(".gitignore")).toBeNull();
  });

  it("refuses names that would change the path's meaning", () => {
    expect(entryNameError("")).toBe("名称不能为空");
    expect(entryNameError("   ")).toBe("名称不能为空");
    expect(entryNameError("a/b")).toMatch(/不能包含/);
    expect(entryNameError("a\\b")).toMatch(/不能包含/);
    expect(entryNameError(".")).toMatch(/「\.」/);
    expect(entryNameError("..")).toMatch(/「\.」/);
    expect(entryNameError("a\u0000b")).toBe("名称不能包含控制字符");
  });
});

describe("moveTargetError", () => {
  const dir = { path: "docs", isDir: true };
  const file = { path: "docs/a.md", isDir: false };

  it("refuses a move that would land where the entry already is", () => {
    expect(moveTargetError(file, "docs")).toBe("已经在这个文件夹里了");
    expect(moveTargetError(dir, "")).toBe("已经在这个文件夹里了");
  });

  it("refuses moving a folder into itself or a descendant", () => {
    expect(moveTargetError(dir, "docs")).toMatch(/自己/);
    expect(moveTargetError(dir, "docs/notes")).toMatch(/自己/);
  });

  it("allows a real relocation", () => {
    expect(moveTargetError(file, "")).toBeNull();
    expect(moveTargetError(file, "archive")).toBeNull();
    expect(moveTargetError(dir, "archive")).toBeNull();
  });
});
