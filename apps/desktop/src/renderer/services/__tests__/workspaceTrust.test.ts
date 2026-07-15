import {
  clearTrustedWorkspaceRootsForTests,
  isWorkspaceRootTrusted,
  suggestObserveForUntrustedLocal,
  trustWorkspaceRoot,
} from "@/services/workspaceTrust";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  clearTrustedWorkspaceRootsForTests();
});

describe("workspaceTrust", () => {
  it("persists trusted roots", () => {
    expect(isWorkspaceRootTrusted("C:\\proj\\foo")).toBe(false);
    trustWorkspaceRoot("C:\\proj\\foo");
    expect(isWorkspaceRootTrusted("C:/proj/foo")).toBe(true);
  });

  it("suggests observe only for untrusted non-git local roots", () => {
    expect(
      suggestObserveForUntrustedLocal({
        localRootPath: "D:\\scratch",
        isGitRepo: false,
      }),
    ).toBe(true);
    expect(
      suggestObserveForUntrustedLocal({
        localRootPath: "D:\\scratch",
        isGitRepo: true,
      }),
    ).toBe(false);
    trustWorkspaceRoot("D:\\scratch");
    expect(
      suggestObserveForUntrustedLocal({
        localRootPath: "D:\\scratch",
        isGitRepo: false,
      }),
    ).toBe(false);
  });
});
