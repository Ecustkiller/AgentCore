// @vitest-environment jsdom

import type { FolderMeta } from "@/services/folders";
import type { WorkspaceInfo } from "@/services/workspaces";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveWorkspaceSource,
  createCloudWorkspaceSource,
  createWorkspaceSource,
  resolveConversationLocalFileSource,
} = vi.hoisted(() => ({
  resolveWorkspaceSource: vi.fn(),
  createCloudWorkspaceSource: vi.fn(),
  createWorkspaceSource: vi.fn(),
  resolveConversationLocalFileSource: vi.fn(),
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => convState.list,
  getConversations: () => convState.list,
  useGroupedConversationsSettled: () => metaState.settled,
}));
vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => foldersState.list,
  getFolders: () => foldersState.list,
}));
vi.mock("@/hooks/useWorkspaces", () => ({
  useConversationWorkspace: vi.fn(),
  useWorkspaces: () => ({ data: workspacesState.list, isError: false }),
}));
vi.mock("@/lib/capabilities", () => ({
  hasInAppPreview: vi.fn(() => false),
  hasLocalFiles: vi.fn(() => true),
}));
vi.mock("@/lib/offlineMode", () => ({
  useReadOnlyOffline: () => false,
}));
vi.mock("@/services/sources/workspaceSource", () => ({
  createWorkspaceSource,
  createCloudWorkspaceSource,
  resolveWorkspaceSource,
  resolveConversationLocalFileSource,
}));
vi.mock("@/services/sources/readOnlyFileSource", () => ({
  asReadOnlyFileSource: (s: unknown) => s,
}));
vi.mock("@/lib/openWorkspaceHtmlInBrowser", () => ({
  openWorkspaceHtmlInBrowser: vi.fn(),
}));
vi.mock("@/services/workspace", () => ({
  openWorkspaceInBrowser: vi.fn(),
}));

import {
  useConversationFileSource,
  useFileTabSource,
  useFileTabSourceState,
} from "@/hooks/useConversationFileSource";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { workspaceKeys } from "@/lib/queryKeys";
import type { Conversation } from "@/stores/conversation";

const foldersState: { list: FolderMeta[] } = { list: [] };
const workspacesState: { list: WorkspaceInfo[] | undefined } = { list: [] };
const convState: { list: Conversation[] } = { list: [] };
const metaState: { settled: boolean } = { settled: true };

const sessionWs: WorkspaceInfo = {
  wsId: "folder:birth",
  name: "出生桌",
  location: "cloud",
  rootId: null,
  subpath: "",
  hasFiles: true,
};

const landedWs: WorkspaceInfo = {
  wsId: "folder:landed",
  name: "落地桌",
  location: "cloud",
  rootId: null,
  subpath: "",
  hasFiles: true,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(workspaceKeys.list, workspacesState.list);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function resetMocks() {
  vi.clearAllMocks();
  foldersState.list = [];
  convState.list = [];
  metaState.settled = true;
  workspacesState.list = [sessionWs, landedWs];
  vi.mocked(useConversationWorkspace).mockReturnValue(sessionWs);
  resolveWorkspaceSource.mockImplementation((ws: WorkspaceInfo) => ({
    id: `workspace:${ws.wsId}`,
    label: ws.name,
  }));
  createCloudWorkspaceSource.mockImplementation((wsId: string) => ({
    id: `workspace:${wsId}`,
    label: "工作区",
  }));
  createWorkspaceSource.mockImplementation((cid: string) => ({
    id: `workspace:${cid}`,
  }));
  resolveConversationLocalFileSource.mockResolvedValue(null);
}

describe("useFileTabSource — 产物 File tab 跟落地桌", () => {
  beforeEach(resetMocks);

  it("带 workspaceId 时用该桌源；无则回退会话出生桌", () => {
    const { result: session } = renderHook(
      () => useConversationFileSource("conv-1"),
      { wrapper },
    );
    const { result: landed } = renderHook(
      () => useFileTabSource("conv-1", "folder:landed"),
      { wrapper },
    );
    const { result: fallback } = renderHook(
      () => useFileTabSource("conv-1", undefined),
      { wrapper },
    );

    expect(landed.current?.id).toBe("workspace:folder:landed");
    expect(resolveWorkspaceSource).toHaveBeenCalledWith(
      expect.objectContaining({ wsId: "folder:landed" }),
      true,
    );
    expect(fallback.current?.id).toBe(session.current?.id);
    expect(fallback.current?.id).toBe("workspace:folder:birth");
  });

  it("查不到工作区行时回退云 REST 源（仍按 workspaceId 寻址）", () => {
    workspacesState.list = [sessionWs];
    const { result } = renderHook(
      () => useFileTabSource("conv-1", "folder:missing"),
      { wrapper },
    );
    expect(createCloudWorkspaceSource).toHaveBeenCalledWith("folder:missing");
    expect(result.current?.id).toBe("workspace:folder:missing");
  });

  it("本机传统 folder 行可从 folders 合成（不写死云 REST）", () => {
    workspacesState.list = [sessionWs];
    foldersState.list = [
      {
        id: "local-proj",
        name: "本机项目",
        mode: "local",
        localRootId: "root-1",
        localSubpath: "apps",
      },
    ];
    const { result } = renderHook(
      () => useFileTabSource("conv-1", "folder:local-proj"),
      { wrapper },
    );
    expect(resolveWorkspaceSource).toHaveBeenCalledWith(
      expect.objectContaining({
        wsId: "folder:local-proj",
        location: "local",
        rootId: "root-1",
        subpath: "apps",
      }),
      true,
    );
    expect(createCloudWorkspaceSource).not.toHaveBeenCalled();
    expect(result.current?.id).toBe("workspace:folder:local-proj");
  });
});

/**
 * 回归：真 OS 浮窗是新渲染进程，名册 / grouped 缓存全空，而 tab 经 BroadcastChannel
 * 投影瞬间到达。此时把「还不知道归属」当成「云端」，本机桌首个读就打服务端空目录，
 * 用户看到 `API 404: 文件不存在`，返回再进（缓存已热）才正常。
 */
describe("useFileTabSource — 元数据未到位时不得猜云端（浮窗冷缓存 404）", () => {
  beforeEach(() => {
    resetMocks();
    // 冷渲染进程：名册在飞、grouped 在飞、工作区行还合成不出来。
    workspacesState.list = undefined;
    metaState.settled = false;
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("落地桌未知时挂起，不回退云 REST", () => {
    const { result } = renderHook(
      () => useFileTabSourceState("conv-1", "folder:local-proj"),
      { wrapper },
    );
    expect(result.current).toEqual({ source: null, pending: true });
    expect(createCloudWorkspaceSource).not.toHaveBeenCalled();
  });

  it("无 workspaceId 的产物同样挂起，不落会话云 REST 源", () => {
    const { result } = renderHook(() => useFileTabSourceState("conv-1"), {
      wrapper,
    });
    expect(result.current).toEqual({ source: null, pending: true });
    expect(createWorkspaceSource).not.toHaveBeenCalled();
  });

  it("元数据落定后解析到本机源（挂起只是等待，不是失败）", () => {
    metaState.settled = true;
    workspacesState.list = [];
    foldersState.list = [
      {
        id: "local-proj",
        name: "本机项目",
        mode: "local",
        localRootId: "root-1",
        localSubpath: "",
      },
    ];
    const { result } = renderHook(
      () => useFileTabSourceState("conv-1", "folder:local-proj"),
      { wrapper },
    );
    expect(result.current.pending).toBe(false);
    expect(result.current.source?.id).toBe("workspace:folder:local-proj");
    expect(resolveWorkspaceSource).toHaveBeenCalledWith(
      expect.objectContaining({ location: "local", rootId: "root-1" }),
      true,
    );
  });

  it("名册已到位但确实查无此桌时，仍按原样回退云 REST", () => {
    metaState.settled = true;
    workspacesState.list = [];
    const { result } = renderHook(
      () => useFileTabSourceState("conv-1", "folder:missing"),
      { wrapper },
    );
    expect(result.current.pending).toBe(false);
    expect(createCloudWorkspaceSource).toHaveBeenCalledWith("folder:missing");
  });
});
