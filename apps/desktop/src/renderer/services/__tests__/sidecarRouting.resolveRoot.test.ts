// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const uiState = {
  sidecarEnabled: false,
  sidecarPreference: "unset" as "unset" | "on" | "off",
};

vi.mock("@/hooks/useConversations", () => ({
  getConversations: vi.fn(),
}));
vi.mock("@/hooks/useFolders", () => ({
  getFolders: vi.fn(() => []),
}));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { getQueryData: vi.fn(() => undefined) },
}));
vi.mock("@/lib/queryKeys", () => ({
  workspaceKeys: { list: ["workspaces"] },
}));
vi.mock("@/lib/capabilities", () => ({
  hasLocalEngine: () => true,
}));
vi.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => uiState },
}));
vi.mock("@/stores/conversation", () => ({
  getRuntime: () => ({ messages: [] }),
}));

import { getConversations } from "@/hooks/useConversations";
import { getFolders } from "@/hooks/useFolders";
import {
  resolveConversationLocalTarget,
  resolveSidecarRoot,
} from "@/services/sidecarRouting";

const getConvs = getConversations as unknown as ReturnType<typeof vi.fn>;
const getFolds = getFolders as unknown as ReturnType<typeof vi.fn>;

describe("resolveSidecarRoot（新回合路由 · 本机传统默认同侧）", () => {
  beforeEach(() => {
    uiState.sidecarEnabled = false;
    uiState.sidecarPreference = "unset";
    getConvs.mockReset();
    getFolds.mockReset();
    getFolds.mockReturnValue([]);
    getConvs.mockReturnValue([
      {
        id: "c1",
        title: "t",
        folderId: null,
        localContainerRootId: "container",
      },
    ]);
    window.fsApi = {
      listRoots: vi
        .fn()
        .mockResolvedValue([{ id: "container", name: "AgentCore" }]),
    } as unknown as typeof window.fsApi;
  });

  it("unset（默认关布尔）不挡本机绑定 → 解析 sidecar 目标", async () => {
    uiState.sidecarEnabled = false;
    uiState.sidecarPreference = "unset";
    const target = await resolveSidecarRoot("c1");
    expect(target).toEqual({
      rootId: "container",
      subpath: "conversations/c1",
    });
    expect(window.fsApi.listRoots).toHaveBeenCalled();
  });

  it("显式 off → 强制关，早退 null，不 listRoots", async () => {
    uiState.sidecarEnabled = false;
    uiState.sidecarPreference = "off";
    const target = await resolveSidecarRoot("c1");
    expect(target).toBeNull();
    expect(window.fsApi.listRoots).not.toHaveBeenCalled();
  });

  it("显式 on → 仍解析本机绑定目标", async () => {
    uiState.sidecarEnabled = true;
    uiState.sidecarPreference = "on";
    const target = await resolveSidecarRoot("c1");
    expect(target).toEqual({
      rootId: "container",
      subpath: "conversations/c1",
    });
    expect(window.fsApi.listRoots).toHaveBeenCalled();
  });

  it("§7.2 mode=cloud 项目 → 无 sidecar target（全云）", async () => {
    getConvs.mockReturnValue([
      {
        id: "c-cloud",
        title: "t",
        folderId: "f-cloud",
        localContainerRootId: null,
      },
    ]);
    getFolds.mockReturnValue([
      {
        id: "f-cloud",
        name: "CloudProj",
        mode: "cloud",
        localRootId: null,
        localSubpath: null,
      },
    ]);
    uiState.sidecarEnabled = true;
    uiState.sidecarPreference = "on";
    expect(await resolveConversationLocalTarget("c-cloud")).toBeNull();
    expect(await resolveSidecarRoot("c-cloud")).toBeNull();
    expect(window.fsApi.listRoots).not.toHaveBeenCalled();
  });

  it("§7.2 mode=local + unset → 默认同侧 sidecar", async () => {
    getConvs.mockReturnValue([
      {
        id: "c-local",
        title: "t",
        folderId: "f-local",
        localContainerRootId: null,
      },
    ]);
    getFolds.mockReturnValue([
      {
        id: "f-local",
        name: "LegacyLocal",
        mode: "local",
        localRootId: "proj-root",
        localSubpath: "",
      },
    ]);
    window.fsApi = {
      listRoots: vi
        .fn()
        .mockResolvedValue([{ id: "proj-root", name: "LegacyLocal" }]),
    } as unknown as typeof window.fsApi;

    uiState.sidecarEnabled = false;
    uiState.sidecarPreference = "unset";
    expect(await resolveConversationLocalTarget("c-local")).toEqual({
      rootId: "proj-root",
      subpath: "",
    });
    expect(await resolveSidecarRoot("c-local")).toEqual({
      rootId: "proj-root",
      subpath: "",
    });
  });
});
