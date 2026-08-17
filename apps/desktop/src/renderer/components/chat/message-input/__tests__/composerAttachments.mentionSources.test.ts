import type { FsApi } from "@shared/ipc-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMentionSources } from "../composerAttachments";

const {
  getWorkspaceBinding,
  resolveConversationLocalTarget,
  getConversations,
  getFolders,
} = vi.hoisted(() => ({
  getWorkspaceBinding: vi.fn(),
  resolveConversationLocalTarget: vi.fn(),
  getConversations: vi.fn(
    (): Array<{
      folderId?: string | null;
      localRootId?: string | null;
      localContainerRootId?: string | null;
      updatedAt: string;
    }> => [],
  ),
  getFolders: vi.fn(
    (): Array<{ id: string; localRootId: string | null }> => [],
  ),
}));

vi.mock("@/services/workspaceBinding", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/workspaceBinding")>();
  return { ...actual, getWorkspaceBinding };
});
vi.mock("@/services/sidecarRouting", () => ({
  resolveConversationLocalTarget,
}));
vi.mock("@/hooks/useConversations", () => ({
  getConversations,
}));
vi.mock("@/hooks/useFolders", () => ({
  getFolders,
}));
vi.mock("@/services/sources/workspaceSource", () => ({
  createCloudWorkspaceSource: (wsId: string, label: string) => ({
    id: `workspace:${wsId}`,
    label,
    caps: { watch: false, transfer: true, edit: true, snapshots: true },
  }),
}));

const ALL_ROOTS = [
  { id: "proj", name: "Project" },
  { id: "ac1", name: "AgentCore" },
  { id: "eval-a", name: "ws-a" },
  { id: "desk", name: "Desktop" },
  { id: "desk-a", name: "notes" },
  { id: "ac2", name: "AgentCore" },
  { id: "other", name: "reports" },
];

describe("buildMentionSources", () => {
  let listRoots: ReturnType<typeof vi.fn>;
  let listDir: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getWorkspaceBinding.mockReset();
    resolveConversationLocalTarget.mockReset();
    getConversations.mockReset().mockReturnValue([]);
    getFolders.mockReset().mockReturnValue([]);
    listRoots = vi.fn().mockResolvedValue(ALL_ROOTS);
    listDir = vi.fn().mockResolvedValue({ ok: false, reason: "not_found" });
    (globalThis as unknown as { window: { fsApi: Partial<FsApi> } }).window = {
      fsApi: {
        listRoots: listRoots as FsApi["listRoots"],
        listDir: listDir as FsApi["listDir"],
      },
    };
  });

  it("local binding → only the bound root (with subpath)", async () => {
    getWorkspaceBinding.mockResolvedValue({
      mode: "local",
      scope: "folder",
      rootId: "ac1",
      source: "explicit",
    });
    resolveConversationLocalTarget.mockResolvedValue({
      rootId: "ac1",
      subpath: "apps/desktop",
    });

    const sources = await buildMentionSources("c1");

    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe("local:ac1:apps/desktop");
    expect(sources[0]?.label).toBe("AgentCore");
    expect(listDir).not.toHaveBeenCalled();
  });

  it("cloud binding → workspace source only, no local roots", async () => {
    getWorkspaceBinding.mockResolvedValue({
      mode: "cloud",
      scope: "conversation",
      rootId: null,
      source: null,
    });

    const sources = await buildMentionSources("c1");

    expect(sources).toEqual([
      expect.objectContaining({
        id: "workspace:conv:c1",
        label: "工作区",
      }),
    ]);
    expect(listRoots).not.toHaveBeenCalled();
  });

  it("unbound → recent used roots, not the full authorized list", async () => {
    getWorkspaceBinding.mockRejectedValue(new Error("no binding"));
    getConversations.mockReturnValue([
      {
        folderId: "f1",
        updatedAt: "2026-08-17T12:00:00.000Z",
      },
      {
        folderId: null,
        localContainerRootId: "other",
        updatedAt: "2026-08-17T11:00:00.000Z",
      },
    ]);
    getFolders.mockReturnValue([{ id: "f1", localRootId: "ac1" }]);

    const sources = await buildMentionSources("c1");

    expect(sources.map((s) => s.id)).toEqual(["local:ac1", "local:other"]);
    expect(sources).toHaveLength(2);
    expect(sources.length).toBeLessThan(ALL_ROOTS.length);
    expect(listDir).not.toHaveBeenCalled();
  });

  it("folds nested roots using absPath from listRoots", async () => {
    getWorkspaceBinding.mockRejectedValue(new Error("no binding"));
    listRoots.mockResolvedValue([
      { id: "proj", name: "Project", absPath: "C:\\Project" },
      { id: "ac1", name: "AgentCore", absPath: "C:\\Project\\AgentCore" },
      { id: "ac2", name: "AgentCore", absPath: "D:\\work\\AgentCore" },
    ]);

    const sources = await buildMentionSources("c1");

    expect(listDir).not.toHaveBeenCalled();
    expect(sources.map((s) => s.id).sort()).toEqual(["local:ac1", "local:ac2"]);
    expect(sources.map((s) => s.label).sort()).toEqual([
      "Project/AgentCore",
      "work/AgentCore",
    ]);
  });
});
