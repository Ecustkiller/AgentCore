import type { FolderMeta } from "@/services/folders";
import { describe, expect, it } from "vitest";
import {
  DRAFT_FOLDER_PREVIEW_LIMIT,
  sortFoldersByRecentActivity,
  visibleDraftFolders,
} from "../draftWorkspaceFolders";

function folder(
  id: string,
  name: string,
  mode: "local" | "cloud" = "local",
): FolderMeta {
  return {
    id,
    name,
    mode,
    localRootId: mode === "local" ? "root" : null,
    localSubpath: null,
  };
}

describe("sortFoldersByRecentActivity", () => {
  it("orders by max conversation updatedAt, then name", () => {
    const folders = [
      folder("a", "Alpha"),
      folder("b", "Beta"),
      folder("c", "Gamma"),
    ];
    const conversations = [
      { folderId: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
      { folderId: "b", updatedAt: "2026-03-01T00:00:00.000Z" },
      { folderId: "c", updatedAt: "2026-02-01T00:00:00.000Z" },
    ];
    expect(
      sortFoldersByRecentActivity(folders, conversations).map((f) => f.id),
    ).toEqual(["b", "c", "a"]);
  });
});

describe("visibleDraftFolders", () => {
  const folders = [
    folder("1", "One"),
    folder("2", "Two"),
    folder("3", "Three"),
    folder("4", "Four"),
    folder("5", "Five"),
    folder("6", "Six"),
    folder("7", "Seven"),
  ];
  const conversations = folders.map((f, i) => ({
    folderId: f.id,
    // Higher id → more recent
    updatedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
  }));

  it("caps to preview limit when collapsed and unfiltered", () => {
    const r = visibleDraftFolders({
      folders,
      conversations,
      query: "",
      expanded: false,
    });
    expect(r.visible.map((f) => f.id)).toEqual(["7", "6", "5", "4", "3"]);
    expect(r.matchCount).toBe(7);
    expect(r.canExpand).toBe(true);
    expect(r.hiddenCount).toBe(2);
    expect(r.visible).toHaveLength(DRAFT_FOLDER_PREVIEW_LIMIT);
  });

  it("shows all when expanded", () => {
    const r = visibleDraftFolders({
      folders,
      conversations,
      query: "",
      expanded: true,
    });
    expect(r.visible).toHaveLength(7);
    expect(r.hiddenCount).toBe(0);
    expect(r.canExpand).toBe(true);
  });

  it("does not cap while filtering", () => {
    const r = visibleDraftFolders({
      folders,
      conversations,
      query: "s",
      expanded: false,
    });
    // Six, Seven (and possibly others with "s" — none)
    expect(r.visible.map((f) => f.name).sort()).toEqual(["Seven", "Six"]);
    expect(r.canExpand).toBe(false);
  });

  it("keeps a selected folder visible when outside the preview", () => {
    const r = visibleDraftFolders({
      folders,
      conversations,
      query: "",
      expanded: false,
      selectedFolderId: "1",
    });
    expect(r.visible.map((f) => f.id)).toEqual(["7", "6", "5", "4", "3", "1"]);
    expect(r.hiddenCount).toBe(1);
  });
});
