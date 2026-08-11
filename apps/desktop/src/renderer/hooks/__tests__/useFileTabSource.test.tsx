// @vitest-environment jsdom

import type { FolderMeta } from "@/services/folders";
import type { WorkspaceInfo } from "@/services/workspaces";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveWorkspaceSource, createCloudWorkspaceSource } = vi.hoisted(
  () => ({
    resolveWorkspaceSource: vi.fn(),
    createCloudWorkspaceSource: vi.fn(),
  }),
);

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => [],
  getConversations: () => [],
}));
vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => foldersState.list,
  getFolders: () => foldersState.list,
}));
vi.mock("@/hooks/useWorkspaces", () => ({
  useConversationWorkspace: vi.fn(),
  useWorkspaces: () => ({ data: workspacesState.list }),
}));
vi.mock("@/lib/capabilities", () => ({
  hasInAppPreview: vi.fn(() => false),
  hasLocalFiles: vi.fn(() => true),
}));
vi.mock("@/lib/offlineMode", () => ({
  useReadOnlyOffline: () => false,
}));
vi.mock("@/services/sources/workspaceSource", () => ({
  createWorkspaceSource: vi.fn(() => ({ id: "workspace:session-conv" })),
  createCloudWorkspaceSource,
  resolveWorkspaceSource,
  resolveConversationLocalFileSource: vi.fn(),
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
} from "@/hooks/useConversationFileSource";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { workspaceKeys } from "@/lib/queryKeys";

const foldersState: { list: FolderMeta[] } = { list: [] };
const workspacesState: { list: WorkspaceInfo[] } = { list: [] };

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

describe("useFileTabSource — 产物 File tab 跟落地桌", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    foldersState.list = [];
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
  });

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
