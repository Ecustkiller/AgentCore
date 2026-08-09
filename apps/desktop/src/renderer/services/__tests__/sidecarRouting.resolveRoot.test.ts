// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const uiState = { sidecarEnabled: false };

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
import { resolveSidecarRoot } from "@/services/sidecarRouting";

const getConvs = getConversations as unknown as ReturnType<typeof vi.fn>;

describe("resolveSidecarRoot（新回合路由 · 默认关早退）", () => {
  beforeEach(() => {
    uiState.sidecarEnabled = false;
    getConvs.mockReset();
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

  it("开关关（含 unset→默认关）→ 早退 null，不 listRoots / 不 spawn", async () => {
    uiState.sidecarEnabled = false;
    const target = await resolveSidecarRoot("c1");
    expect(target).toBeNull();
    expect(window.fsApi.listRoots).not.toHaveBeenCalled();
  });

  it("显式 on → 仍解析本机绑定目标", async () => {
    uiState.sidecarEnabled = true;
    const target = await resolveSidecarRoot("c1");
    expect(target).toEqual({
      rootId: "container",
      subpath: "conversations/c1",
    });
    expect(window.fsApi.listRoots).toHaveBeenCalled();
  });
});
