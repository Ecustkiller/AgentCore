import type { FolderMeta } from "@/services/folders";
import { beforeEach, describe, expect, it } from "vitest";
import { useFoldersStore } from "../folders";

const store = () => useFoldersStore.getState();

const folder = (id: string, name = id): FolderMeta => ({
  id,
  name,
  localDir: null,
  localRootId: null,
});

beforeEach(() => {
  // The store hydrates `collapsed` from localStorage at import; pin a known
  // baseline so each test starts empty and deterministic.
  useFoldersStore.setState({
    folders: [],
    collapsed: {},
    pendingRenameId: null,
    pendingNewChatFolderId: null,
  });
});

describe("setFolders / addFolder", () => {
  it("replaces the list and prepends new folders (newest first)", () => {
    store().setFolders([folder("a"), folder("b")]);
    expect(store().folders.map((f) => f.id)).toEqual(["a", "b"]);

    store().addFolder(folder("c"));
    expect(store().folders.map((f) => f.id)).toEqual(["c", "a", "b"]);
  });
});

describe("updateFolderMeta", () => {
  it("patches only the matching folder", () => {
    store().setFolders([folder("a", "Work"), folder("b", "Notes")]);
    store().updateFolderMeta("a", { name: "Renamed" });
    expect(store().folders.find((f) => f.id === "a")?.name).toBe("Renamed");
    expect(store().folders.find((f) => f.id === "b")?.name).toBe("Notes");
  });
});

describe("removeFolder", () => {
  it("drops the folder and its collapse entry", () => {
    store().setFolders([folder("a"), folder("b")]);
    store().toggleCollapsed("a");
    expect(store().collapsed.a).toBe(true);

    store().removeFolder("a");
    expect(store().folders.map((f) => f.id)).toEqual(["b"]);
    expect(store().collapsed.a).toBeUndefined();
  });
});

describe("toggleCollapsed", () => {
  it("flips a key (default expanded → collapsed → expanded)", () => {
    expect(store().collapsed.x ?? false).toBe(false);
    store().toggleCollapsed("x");
    expect(store().collapsed.x).toBe(true);
    store().toggleCollapsed("x");
    expect(store().collapsed.x).toBe(false);
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
