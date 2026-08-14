import {
  listingDesksFor,
  loadFileListingMeta,
  resetArtifactListingMetaInflight,
} from "@/lib/artifactListingMeta";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listWorkspaceFiles, listWorkspaceFilesByWs } = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  listWorkspaceFilesByWs: vi.fn(),
}));

vi.mock("@/api/workspace", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/workspace")>("@/api/workspace");
  return { ...actual, listWorkspaceFiles };
});

vi.mock("@/api/workspaces", () => ({
  listWorkspaceFilesByWs,
}));

describe("listingDesksFor", () => {
  it("uses conversation list unless a row carries workspaceId", () => {
    expect(
      listingDesksFor(
        [{ path: "a.md", name: "a.md", acceptance: "accepted" }],
        "c1",
      ),
    ).toEqual([{ kind: "conv", id: "c1" }]);
    expect(
      listingDesksFor(
        [
          {
            path: "a.md",
            name: "a.md",
            acceptance: "accepted",
            workspaceId: "folder:p1",
          },
        ],
        "c1",
      ),
    ).toEqual([{ kind: "ws", id: "folder:p1" }]);
  });

  it("skips deletes and rows with no desk", () => {
    expect(
      listingDesksFor(
        [{ path: "gone.md", name: "gone.md", op: "delete" }],
        "c1",
      ),
    ).toEqual([]);
    expect(
      listingDesksFor(
        [{ path: "a.md", name: "a.md", acceptance: "accepted" }],
        null,
      ),
    ).toEqual([]);
  });
});

describe("loadFileListingMeta", () => {
  beforeEach(() => {
    resetArtifactListingMetaInflight();
    listWorkspaceFiles.mockReset();
    listWorkspaceFilesByWs.mockReset();
  });

  it("indexes the existing conversation list by path", async () => {
    listWorkspaceFiles.mockResolvedValue({
      entries: [
        {
          path: "notes.md",
          is_dir: false,
          size_bytes: 12,
          mtime_ms: 99,
        },
      ],
      truncated: false,
    });
    const map = await loadFileListingMeta({ kind: "conv", id: "c1" });
    expect(listWorkspaceFiles).toHaveBeenCalledWith("c1");
    expect(map.get("notes.md")).toEqual({ sizeBytes: 12, mtimeMs: 99 });
  });

  it("returns an empty map when list fails (leave rows blank)", async () => {
    listWorkspaceFiles.mockRejectedValue(new Error("offline"));
    await expect(
      loadFileListingMeta({ kind: "conv", id: "c1" }),
    ).resolves.toEqual(new Map());
  });

  it("joins concurrent loads of the same desk", async () => {
    let resolveList: (v: unknown) => void = () => {};
    listWorkspaceFiles.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const a = loadFileListingMeta({ kind: "conv", id: "c1" });
    const b = loadFileListingMeta({ kind: "conv", id: "c1" });
    resolveList({
      entries: [{ path: "a.md", is_dir: false, size_bytes: 1, mtime_ms: 2 }],
      truncated: false,
    });
    const [ma, mb] = await Promise.all([a, b]);
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(ma.get("a.md")).toEqual({ sizeBytes: 1, mtimeMs: 2 });
    expect(mb.get("a.md")).toEqual({ sizeBytes: 1, mtimeMs: 2 });
  });

  it("uses the existing workspace list for ws desks", async () => {
    listWorkspaceFilesByWs.mockResolvedValue({
      entries: [],
      truncated: false,
    });
    await loadFileListingMeta({ kind: "ws", id: "folder:p1" });
    expect(listWorkspaceFilesByWs).toHaveBeenCalledWith("folder:p1");
    expect(listWorkspaceFiles).not.toHaveBeenCalled();
  });
});
