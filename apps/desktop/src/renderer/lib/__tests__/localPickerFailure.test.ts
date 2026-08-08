// @vitest-environment jsdom
import {
  isLocalPickerFailureKind,
  localPickerFailureCopy,
  pickAndBindLocalFolder,
  pickLocalFolderRoot,
} from "@/lib/bindLocalFolder";
import { pickAndOpenLocalProject } from "@/lib/openLocalProject";
import { pickAndRegisterLocalProject } from "@/lib/registerLocalProject";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: vi.fn(() => true),
}));

vi.mock("@/hooks/useFolders", () => ({
  getFolders: vi.fn(() => []),
  addFolderCache: vi.fn(),
}));

vi.mock("@/lib/newConversation", () => ({
  startNewConversation: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/services/folders", () => ({
  createFolder: vi.fn(),
  findLocalFolderByBinding: vi.fn(() => undefined),
}));

vi.mock("@/services/workspaceBinding", () => ({
  bindLocalWorkspace: vi.fn(),
}));

vi.mock("@/hooks/useConversations", () => ({
  getConversations: vi.fn(() => []),
  patchConversationCache: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  patchConversationScratch: vi.fn(),
}));

vi.mock("@/stores/backgroundTasks", () => ({
  useBackgroundTasksStore: { setState: vi.fn() },
}));

describe("localPickerFailureCopy", () => {
  it("exposes fixed titles for dialog / auth / unavailable", () => {
    expect(localPickerFailureCopy("dialog_failed").title).toContain(
      "未弹出文件夹选择器",
    );
    expect(localPickerFailureCopy("unauthorized").title).toContain(
      "未能授权本机目录",
    );
    expect(localPickerFailureCopy("unavailable").title).toContain(
      "本机目录仅桌面端可用",
    );
    expect(isLocalPickerFailureKind("cancelled")).toBe(false);
    expect(isLocalPickerFailureKind("dialog_failed")).toBe(true);
    expect(isLocalPickerFailureKind("no_package_json")).toBe(false);
  });
});

describe("pickLocalFolderRoot structured failures", () => {
  beforeEach(() => {
    window.fsApi = {
      addRoot: vi.fn(),
      listDir: vi.fn(),
    } as unknown as typeof window.fsApi;
  });

  it("maps dialog_failed from addRoot", async () => {
    vi.mocked(window.fsApi.addRoot).mockResolvedValue({
      ok: false,
      reason: "dialog_failed",
      message: "系统未能打开文件夹选择器",
    });
    const result = await pickLocalFolderRoot();
    expect(result).toEqual({
      ok: false,
      reason: "dialog_failed",
      message: "系统未能打开文件夹选择器",
    });
  });

  it("maps unauthorized from addRoot", async () => {
    vi.mocked(window.fsApi.addRoot).mockResolvedValue({
      ok: false,
      reason: "unauthorized",
      message: "所选目录无法访问，未能完成本机授权",
    });
    const result = await pickLocalFolderRoot();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("keeps cancelled silent (no structured kind)", async () => {
    vi.mocked(window.fsApi.addRoot).mockResolvedValue({
      ok: false,
      reason: "cancelled",
    });
    await expect(pickLocalFolderRoot()).resolves.toEqual({
      ok: false,
      reason: "cancelled",
    });
  });
});

describe("pickAndOpenLocalProject without language marker", () => {
  beforeEach(() => {
    window.fsApi = {
      addRoot: vi.fn().mockResolvedValue({
        ok: true,
        root: { id: "r1", name: "docs-only" },
      }),
      listDir: vi.fn(),
    } as unknown as typeof window.fsApi;
  });

  it("opens a folder that has no package.json", async () => {
    const { createFolder } = await import("@/services/folders");
    vi.mocked(createFolder).mockResolvedValue({
      folder: {
        id: "f1",
        name: "docs-only",
        mode: "local",
        localRootId: "r1",
        localSubpath: null,
      },
      created: true,
    });

    const result = await pickAndOpenLocalProject(vi.fn(), {
      notifyOnFailure: false,
    });
    expect(result.ok).toBe(true);
    expect(window.fsApi.listDir).not.toHaveBeenCalled();
  });
});

describe("pickAndRegisterLocalProject stays on conversation", () => {
  beforeEach(async () => {
    window.fsApi = {
      addRoot: vi.fn().mockResolvedValue({
        ok: true,
        root: { id: "r1", name: "my-repo" },
      }),
      listDir: vi.fn(),
    } as unknown as typeof window.fsApi;
    const { findLocalFolderByBinding } = await import("@/services/folders");
    const { startNewConversation } = await import("@/lib/newConversation");
    vi.mocked(findLocalFolderByBinding).mockReturnValue(undefined);
    vi.mocked(startNewConversation).mockClear();
  });

  it("creates folder without package.json and without startNewConversation", async () => {
    const { createFolder } = await import("@/services/folders");
    const { startNewConversation } = await import("@/lib/newConversation");
    vi.mocked(createFolder).mockResolvedValue({
      folder: {
        id: "f2",
        name: "my-repo",
        mode: "local",
        localRootId: "r1",
        localSubpath: null,
      },
      created: true,
    });

    const result = await pickAndRegisterLocalProject({
      notifyOnFailure: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folder.id).toBe("f2");
      expect(result.created).toBe(true);
    }
    expect(startNewConversation).not.toHaveBeenCalled();
    expect(window.fsApi.listDir).not.toHaveBeenCalled();
  });

  it("reuses existing folder by binding without new conversation", async () => {
    const { findLocalFolderByBinding } = await import("@/services/folders");
    const { startNewConversation } = await import("@/lib/newConversation");
    vi.mocked(findLocalFolderByBinding).mockReturnValue({
      id: "existing",
      name: "my-repo",
      mode: "local",
      localRootId: "r1",
      localSubpath: null,
    });

    const result = await pickAndRegisterLocalProject({
      notifyOnFailure: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folder.id).toBe("existing");
      expect(result.created).toBe(false);
    }
    expect(startNewConversation).not.toHaveBeenCalled();
  });
});

describe("pickAndBindLocalFolder structured failures", () => {
  beforeEach(() => {
    window.fsApi = {
      addRoot: vi.fn().mockResolvedValue({
        ok: false,
        reason: "dialog_failed",
        message: "系统未能打开文件夹选择器",
      }),
    } as unknown as typeof window.fsApi;
  });

  it("surfaces dialog_failed instead of treating as cancel", async () => {
    const result = await pickAndBindLocalFolder("conv-1");
    expect(result).toEqual({
      ok: false,
      reason: "dialog_failed",
      message: "系统未能打开文件夹选择器",
    });
  });
});
