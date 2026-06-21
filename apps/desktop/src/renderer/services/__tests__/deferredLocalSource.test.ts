import type { FileNode } from "@/lib/fileSource";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Client-side DeferredWorkspace (工作区对称化 D1a): a desktop 裸聊's panel source that
 * promotes a *local* workspace on its first WRITE (never on a read), then delegates to
 * the real local IPC source — the fix for "panel-first write strands a local file on
 * the server". Mirrors the server's test_workspace_symmetry deferred-promotion tests.
 */

const h = vi.hoisted(() => {
  const innerCreateFile = vi.fn(() => Promise.resolve());
  const innerListDir = vi.fn((): Promise<FileNode[]> => Promise.resolve([]));
  const innerRead = vi.fn(() =>
    Promise.resolve({ kind: "text", text: "hi", truncated: false }),
  );
  const inner = {
    id: "local:root-x:Demo",
    label: "Demo",
    caps: { watch: true, transfer: false, edit: true, snapshots: false },
    listDir: innerListDir,
    read: innerRead,
    createFile: innerCreateFile,
    mkdir: vi.fn(() => Promise.resolve()),
    move: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  };
  return {
    promote: vi.fn(() =>
      Promise.resolve({
        id: "f1",
        name: "Demo",
        localDir: null,
        localRootId: "root-x",
        localSubpath: "Demo",
      }),
    ),
    apply: vi.fn(),
    createLocal: vi.fn(() => inner),
    inner,
    innerCreateFile,
    innerListDir,
    innerRead,
  };
});

vi.mock("@/services/folders", () => ({
  promoteConversationWorkspace: h.promote,
}));
vi.mock("@/services/workspacePromotion", () => ({
  applyConversationPromotion: h.apply,
}));
vi.mock("@/services/sources/localRootSource", () => ({
  createLocalRootSource: h.createLocal,
}));

import { createDeferredLocalSource } from "@/services/sources/deferredLocalSource";

describe("createDeferredLocalSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists empty without promoting (a 裸聊 has no files yet)", async () => {
    const src = createDeferredLocalSource("c1", "root-x", "Demo");
    expect(await src.listDir("")).toEqual([]);
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.createLocal).not.toHaveBeenCalled();
  });

  it("a read never triggers promotion (only a write does)", async () => {
    const src = createDeferredLocalSource("c1", "root-x", "Demo");
    await expect(src.read("a.txt")).rejects.toThrow();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it("first write promotes, applies cache patches, then delegates to the local source", async () => {
    const src = createDeferredLocalSource("c1", "root-x", "Demo");
    await src.createFile("a.txt");

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.promote).toHaveBeenCalledWith("c1");
    // The minted local folder is reflected into the caches like the SSE event would.
    expect(h.apply).toHaveBeenCalledWith("c1", {
      id: "f1",
      name: "Demo",
      localDir: null,
      localRootId: "root-x",
      localSubpath: "Demo",
    });
    // Real local IPC source built over the minted root + per-conversation subpath.
    expect(h.createLocal).toHaveBeenCalledWith("root-x", "Demo", "Demo");
    expect(h.innerCreateFile).toHaveBeenCalledWith("a.txt");
  });

  it("promotes once across multiple writes (cached inner, no double-mint)", async () => {
    const src = createDeferredLocalSource("c1", "root-x", "Demo");
    await src.createFile("a.txt");
    await src.createFile("b.txt");

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.createLocal).toHaveBeenCalledTimes(1);
    expect(h.innerCreateFile).toHaveBeenCalledTimes(2);
  });

  it("concurrent first writes still promote only once", async () => {
    const src = createDeferredLocalSource("c1", "root-x", "Demo");
    await Promise.all([src.createFile("a.txt"), src.mkdir("d")]);

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.createLocal).toHaveBeenCalledTimes(1);
  });

  it("after promotion, listDir delegates to the local source", async () => {
    const src = createDeferredLocalSource("c1", "root-x", "Demo");
    await src.createFile("a.txt"); // promote
    h.innerListDir.mockResolvedValueOnce([
      { path: "a.txt", name: "a.txt", isDir: false },
    ]);
    const entries = await src.listDir("");
    expect(entries).toEqual([{ path: "a.txt", name: "a.txt", isDir: false }]);
    expect(h.innerListDir).toHaveBeenCalled();
  });
});
