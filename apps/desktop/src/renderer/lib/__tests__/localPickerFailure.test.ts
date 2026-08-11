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

vi.mock("@/services/accountToken", () => ({
  resolveSidecarAccountAuth: vi.fn().mockResolvedValue({
    baseUrl: "https://api.example.com/v1/account",
    apiKey: "acct-tok",
  }),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "user-1" } }),
  },
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

describe("pickAndOpenLocalProject mode=local", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { findLocalFolderByBinding } = await import("@/services/folders");
    vi.mocked(findLocalFolderByBinding).mockReturnValue(undefined);
    window.fsApi = {
      addRoot: vi.fn().mockResolvedValue({
        ok: true,
        root: { id: "root-1", name: "MyRepo", path: "C:\\MyRepo" },
      }),
      listDir: vi.fn(),
    } as unknown as typeof window.fsApi;
    window.sidecarApi = {
      warmCodeIndex: vi.fn().mockResolvedValue(undefined),
      warmMcpDiscover: vi.fn().mockResolvedValue(undefined),
      warmAccountRulesMemory: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.sidecarApi;
  });

  it("addRoot + createFolder(mode=local) then startNewConversation", async () => {
    const { createFolder } = await import("@/services/folders");
    const { startNewConversation } = await import("@/lib/newConversation");
    const { addFolderCache } = await import("@/hooks/useFolders");
    const folder = {
      id: "folder-1",
      name: "MyRepo",
      mode: "local" as const,
      localRootId: "root-1",
      localSubpath: null,
    };
    vi.mocked(createFolder).mockResolvedValue({ folder, created: true });

    const navigate = vi.fn();
    const result = await pickAndOpenLocalProject(navigate, {
      notifyOnFailure: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folder).toEqual(folder);
      expect(result.created).toBe(true);
    }
    expect(window.fsApi.addRoot).toHaveBeenCalled();
    expect(createFolder).toHaveBeenCalledWith({
      name: "MyRepo",
      mode: "local",
      localRootId: "root-1",
      localSubpath: null,
    });
    expect(addFolderCache).toHaveBeenCalledWith(folder);
    expect(startNewConversation).toHaveBeenCalledWith(navigate, "folder-1");
    expect(window.sidecarApi.warmCodeIndex).toHaveBeenCalledWith({
      rootId: "root-1",
      subpath: "",
    });
    expect(window.sidecarApi.warmMcpDiscover).toHaveBeenCalledWith({
      rootId: "root-1",
      subpath: "",
      userId: "user-1",
    });
    await vi.waitFor(() => {
      expect(window.sidecarApi.warmAccountRulesMemory).toHaveBeenCalledWith({
        rootId: "root-1",
        subpath: "",
        folderId: "folder-1",
        accountAuth: {
          baseUrl: "https://api.example.com/v1/account",
          apiKey: "acct-tok",
        },
        userId: "user-1",
      });
    });
  });

  it("reuses existing local binding without createFolder", async () => {
    const { createFolder, findLocalFolderByBinding } = await import(
      "@/services/folders"
    );
    const { startNewConversation } = await import("@/lib/newConversation");
    const existing = {
      id: "folder-existing",
      name: "MyRepo",
      mode: "local" as const,
      localRootId: "root-1",
      localSubpath: null,
    };
    vi.mocked(findLocalFolderByBinding).mockReturnValue(existing);

    const navigate = vi.fn();
    const result = await pickAndOpenLocalProject(navigate, {
      notifyOnFailure: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(false);
    expect(createFolder).not.toHaveBeenCalled();
    expect(startNewConversation).toHaveBeenCalledWith(
      navigate,
      "folder-existing",
    );
  });
});

describe("pickAndRegisterLocalProject mode=local", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { findLocalFolderByBinding } = await import("@/services/folders");
    vi.mocked(findLocalFolderByBinding).mockReturnValue(undefined);
    window.fsApi = {
      addRoot: vi.fn().mockResolvedValue({
        ok: true,
        root: { id: "root-2", name: "OtherRepo", path: "C:\\OtherRepo" },
      }),
      listDir: vi.fn(),
    } as unknown as typeof window.fsApi;
    window.sidecarApi = {
      warmCodeIndex: vi.fn().mockResolvedValue(undefined),
      warmMcpDiscover: vi.fn().mockResolvedValue(undefined),
      warmAccountRulesMemory: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.sidecarApi;
  });

  it("addRoot + createFolder(mode=local) without startNewConversation", async () => {
    const { createFolder } = await import("@/services/folders");
    const { startNewConversation } = await import("@/lib/newConversation");
    const { addFolderCache } = await import("@/hooks/useFolders");
    const folder = {
      id: "folder-2",
      name: "OtherRepo",
      mode: "local" as const,
      localRootId: "root-2",
      localSubpath: null,
    };
    vi.mocked(createFolder).mockResolvedValue({ folder, created: true });

    const result = await pickAndRegisterLocalProject({
      notifyOnFailure: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folder).toEqual(folder);
      expect(result.created).toBe(true);
    }
    expect(window.fsApi.addRoot).toHaveBeenCalled();
    expect(createFolder).toHaveBeenCalledWith({
      name: "OtherRepo",
      mode: "local",
      localRootId: "root-2",
      localSubpath: null,
    });
    expect(addFolderCache).toHaveBeenCalledWith(folder);
    expect(startNewConversation).not.toHaveBeenCalled();
    expect(window.sidecarApi.warmCodeIndex).toHaveBeenCalledWith({
      rootId: "root-2",
      subpath: "",
    });
    expect(window.sidecarApi.warmMcpDiscover).toHaveBeenCalledWith({
      rootId: "root-2",
      subpath: "",
      userId: "user-1",
    });
    await vi.waitFor(() => {
      expect(window.sidecarApi.warmAccountRulesMemory).toHaveBeenCalledWith({
        rootId: "root-2",
        subpath: "",
        folderId: "folder-2",
        accountAuth: {
          baseUrl: "https://api.example.com/v1/account",
          apiKey: "acct-tok",
        },
        userId: "user-1",
      });
    });
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
