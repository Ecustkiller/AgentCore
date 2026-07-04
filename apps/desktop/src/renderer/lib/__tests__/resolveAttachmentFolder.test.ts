import { resolveFolderFromIndexedEntry } from "@/components/chat/message-input/resolveAttachmentFolder";
import { getConversations } from "@/hooks/useConversations";
import { getFolders } from "@/hooks/useFolders";
import type { IndexedEntry } from "@/lib/fileIndex";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useConversations", () => ({
  getConversations: vi.fn(),
}));

vi.mock("@/hooks/useFolders", () => ({
  getFolders: vi.fn(),
}));

const entry = (patch: Partial<IndexedEntry>): IndexedEntry => ({
  sourceId: "local:root-1",
  sourceLabel: "Demo",
  relPath: "a.txt",
  name: "a.txt",
  display: "Demo/a.txt",
  kind: "file",
  ...patch,
});

describe("resolveFolderFromIndexedEntry", () => {
  beforeEach(() => {
    vi.mocked(getConversations).mockReturnValue([]);
    vi.mocked(getFolders).mockReturnValue([]);
  });

  it("maps cloud workspace source to folder id", () => {
    vi.mocked(getFolders).mockReturnValue([
      {
        id: "f-1",
        name: "云项目",
        localDir: null,
      },
    ]);
    const result = resolveFolderFromIndexedEntry(
      entry({ sourceId: "workspace:folder:f-1", sourceLabel: "云项目" }),
    );
    expect(result).toEqual({ folderId: "f-1", folderName: "云项目" });
  });

  it("returns null for local root (folders no longer bind roots)", () => {
    const result = resolveFolderFromIndexedEntry(
      entry({ sourceId: "local:root-9:sub", sourceLabel: "本地仓" }),
    );
    expect(result).toBeNull();
  });

  it("maps conversation mention to its folder", () => {
    vi.mocked(getConversations).mockReturnValue([
      {
        id: "c-1",
        title: "某对话",
        folderId: "f-2",
        updatedAt: "",
        messageCount: 1,
        lastMessagePreview: null,
        localContainerRootId: null,
      },
    ]);
    vi.mocked(getFolders).mockReturnValue([
      {
        id: "f-2",
        name: "项目 B",
        localDir: null,
      },
    ]);
    const result = resolveFolderFromIndexedEntry(
      entry({
        kind: "conversation",
        relPath: "c-1",
        name: "某对话",
        sourceId: "conversation",
      }),
    );
    expect(result).toEqual({ folderId: "f-2", folderName: "项目 B" });
  });

  it("returns null for unbound local root", () => {
    vi.mocked(getFolders).mockReturnValue([]);
    expect(
      resolveFolderFromIndexedEntry(entry({ sourceId: "local:orphan" })),
    ).toBeNull();
  });
});
