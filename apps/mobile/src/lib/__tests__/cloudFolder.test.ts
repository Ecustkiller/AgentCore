import { describe, expect, it } from "vitest";
import {
  folderWorkspaceId,
  readDraftFolderState,
  workspaceKind,
} from "../cloudFolder";

describe("cloudFolder helpers", () => {
  it("classifies workspace ids by prefix", () => {
    expect(workspaceKind("folder:abc")).toBe("folder");
    expect(workspaceKind("conv:c1")).toBe("conv");
    expect(workspaceKind("shared:s1")).toBe("shared");
    expect(workspaceKind("other")).toBe("other");
  });

  it("builds the files-tab ws id for a folder", () => {
    expect(folderWorkspaceId("f1")).toBe("folder:f1");
  });

  it("reads draft-folder router state and ignores empty ids", () => {
    expect(
      readDraftFolderState({ draftFolderId: "f1", draftFolderName: "设计" }),
    ).toEqual({ id: "f1", name: "设计" });
    expect(readDraftFolderState({ draftFolderId: "  " })).toBeNull();
    expect(readDraftFolderState(null)).toBeNull();
  });
});
