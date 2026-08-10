import {
  normalizeWorkspacePath,
  stripRootLabelPrefix,
  toWorkspaceRelPath,
} from "@/lib/workspacePath";
import { describe, expect, it } from "vitest";

describe("workspacePath", () => {
  it("strips /workspace root label", () => {
    expect(stripRootLabelPrefix("/workspace/foo/bar.md")).toBe("foo/bar.md");
    expect(stripRootLabelPrefix("/workspace")).toBe(".");
    expect(stripRootLabelPrefix("workspace/foo")).toBe("workspace/foo");
  });

  it("toWorkspaceRelPath matches desktop rescue semantics", () => {
    expect(toWorkspaceRelPath("/workspace/version-a-clean.html")).toBe(
      "version-a-clean.html",
    );
    expect(toWorkspaceRelPath("notes.md")).toBe("notes.md");
    expect(toWorkspaceRelPath("/workspace")).toBe("");
    expect(toWorkspaceRelPath("")).toBe("");
  });

  it("normalizeWorkspacePath keeps foreign absolutes", () => {
    expect(normalizeWorkspacePath("/etc/passwd")).toBe("/etc/passwd");
    expect(normalizeWorkspacePath("/")).toBe(".");
  });
});
