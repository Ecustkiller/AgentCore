import { beforeEach, describe, expect, it } from "vitest";
import { useFoldersStore } from "../folders";

const store = () => useFoldersStore.getState();

beforeEach(() => {
  // Pin a known baseline so each test starts empty and deterministic. The folder
  // list itself now lives in React Query (hooks/useFolders); the store only
  // holds these one-shot UI markers.
  useFoldersStore.setState({
    pendingRenameId: null,
    pendingNewChatFolderId: null,
  });
});

describe("pending markers", () => {
  it("tracks pending rename and new-chat folder targets independently", () => {
    store().setPendingRename("a");
    store().setPendingNewChatFolder("b");
    expect(store().pendingRenameId).toBe("a");
    expect(store().pendingNewChatFolderId).toBe("b");

    store().setPendingRename(null);
    expect(store().pendingRenameId).toBeNull();
    expect(store().pendingNewChatFolderId).toBe("b");
  });
});
