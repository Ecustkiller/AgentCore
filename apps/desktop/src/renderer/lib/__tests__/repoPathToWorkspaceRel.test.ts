import { describe, expect, it } from "vitest";
import { repoPathToWorkspaceRel } from "../repoPathToWorkspaceRel";

describe("repoPathToWorkspaceRel", () => {
  it("empty subpath returns repo path unchanged", () => {
    expect(repoPathToWorkspaceRel("src/a.ts", "")).toBe("src/a.ts");
    expect(repoPathToWorkspaceRel("src/a.ts", "  ")).toBe("src/a.ts");
  });

  it("strips matching subpath prefix", () => {
    expect(
      repoPathToWorkspaceRel("conversations/c1/src/a.ts", "conversations/c1"),
    ).toBe("src/a.ts");
    expect(repoPathToWorkspaceRel("ws/file.md", "ws")).toBe("file.md");
  });

  it("returns empty string when path equals subpath", () => {
    expect(repoPathToWorkspaceRel("conversations/c1", "conversations/c1")).toBe(
      "",
    );
  });

  it("returns null when path is outside subpath", () => {
    expect(
      repoPathToWorkspaceRel("other/file.ts", "conversations/c1"),
    ).toBeNull();
    expect(
      repoPathToWorkspaceRel("conversations/c1-extra/x.ts", "conversations/c1"),
    ).toBeNull();
    expect(
      repoPathToWorkspaceRel("conversations", "conversations/c1"),
    ).toBeNull();
  });

  it("normalizes Windows backslashes", () => {
    expect(
      repoPathToWorkspaceRel(
        "conversations\\c1\\src\\a.ts",
        "conversations\\c1",
      ),
    ).toBe("src/a.ts");
    expect(
      repoPathToWorkspaceRel("other\\a.ts", "conversations/c1"),
    ).toBeNull();
  });
});
