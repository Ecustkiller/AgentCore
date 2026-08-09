import {
  canDiscardChange,
  groupGitChangesByDir,
  isUntrackedChange,
  primaryStatusChar,
  shortDirLabel,
  statusCharClass,
  statusSummaryParts,
} from "@/components/workspace/GitChangesSection";
import { describe, expect, it } from "vitest";

describe("GitChangesSection status helpers", () => {
  it("primaryStatusChar picks staged / unstaged / untracked letter", () => {
    expect(primaryStatusChar("M ")).toBe("M");
    expect(primaryStatusChar(" M")).toBe("M");
    expect(primaryStatusChar("A ")).toBe("A");
    expect(primaryStatusChar(" D")).toBe("D");
    expect(primaryStatusChar("??")).toBe("?");
    expect(primaryStatusChar("R ")).toBe("R");
  });

  it("statusCharClass maps industry colors", () => {
    expect(statusCharClass("M")).toContain("warning");
    expect(statusCharClass("A")).toContain("success");
    expect(statusCharClass("?")).toContain("success");
    expect(statusCharClass("D")).toContain("destructive");
    expect(statusCharClass("R")).toContain("primary");
  });

  it("canDiscardChange only for unstaged tracked files", () => {
    expect(canDiscardChange({ path: "a.ts", code: " M" }, false)).toBe(true);
    expect(canDiscardChange({ path: "a.ts", code: "M " }, true)).toBe(false);
    expect(canDiscardChange({ path: "a.ts", code: "??" }, false)).toBe(false);
  });

  it("isUntrackedChange detects ??", () => {
    expect(isUntrackedChange({ path: "a.ts", code: "??" })).toBe(true);
    expect(isUntrackedChange({ path: "a.ts", code: " M" })).toBe(false);
  });

  it("groupGitChangesByDir groups by parent and sorts root first", () => {
    const groups = groupGitChangesByDir([
      { path: "apps/a.ts", code: " M" },
      { path: "root.ts", code: "??" },
      { path: "apps/b.ts", code: " M" },
      { path: "docs/c.md", code: "M " },
    ]);
    expect(groups.map((g) => g.dir)).toEqual(["", "apps", "docs"]);
    expect(groups[0]?.entries.map((e) => e.path)).toEqual(["root.ts"]);
    expect(groups[1]?.entries.map((e) => e.path)).toEqual([
      "apps/a.ts",
      "apps/b.ts",
    ]);
  });

  it("shortDirLabel keeps last 1–2 segments", () => {
    expect(shortDirLabel("")).toBe("仓根");
    expect(shortDirLabel("apps")).toBe("apps");
    expect(shortDirLabel("apps/desktop")).toBe("apps/desktop");
    expect(shortDirLabel("apps/desktop/src/renderer")).toBe("src/renderer");
  });

  it("statusSummaryParts aggregates by primary letter in SCM order", () => {
    expect(
      statusSummaryParts([
        { path: "a.ts", code: " M" },
        { path: "b.ts", code: "M " },
        { path: "c.ts", code: "??" },
        { path: "d.ts", code: " D" },
        { path: "e.ts", code: "??" },
      ]),
    ).toEqual([
      { ch: "M", n: 2 },
      { ch: "D", n: 1 },
      { ch: "?", n: 2 },
    ]);
  });
});
