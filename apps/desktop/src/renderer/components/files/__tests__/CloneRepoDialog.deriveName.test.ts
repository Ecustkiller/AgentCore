import { deriveRepoNameFromUrl } from "@/components/files/CloneRepoDialog";
import { describe, expect, it } from "vitest";

describe("deriveRepoNameFromUrl", () => {
  it("strips .git and takes the last path segment", () => {
    expect(deriveRepoNameFromUrl("https://github.com/acme/agentcore.git")).toBe(
      "agentcore",
    );
    expect(deriveRepoNameFromUrl("https://gitlab.com/acme/agentcore")).toBe(
      "agentcore",
    );
  });

  it("falls back for bad URLs", () => {
    expect(deriveRepoNameFromUrl("not-a-url")).toBe("repo");
  });
});
