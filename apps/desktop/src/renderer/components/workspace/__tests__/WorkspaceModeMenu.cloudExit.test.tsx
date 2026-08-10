// @vitest-environment jsdom
import {
  WorkspaceModeMenu,
  type WorkspaceModeState,
} from "@/components/workspace/WorkspaceModeControl";
import type { EffectiveWorkspace } from "@/lib/workspaceEffectiveMode";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: () => true,
}));

vi.mock("@/hooks/useConversations", () => ({
  getConversations: () => [{ id: "c-cloud", folderId: "f1" }],
}));

vi.mock("@/lib/toast", () => ({
  notifySuccess: vi.fn(),
  notifyActionError: vi.fn(),
}));

const exportCloudDeskZip = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
}));
const exportCloudDeskToPickedFolder = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
}));
const registerMergeLanding = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
  root: { id: "root-1", name: "desk" },
}));
const mergeBackToLanding = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
}));
const mergeArtifactsOnlyToLanding = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
}));
type LandingPeek = {
  rootId: string;
  rootName: string | null;
  missing: boolean;
} | null;
const peekMergeLanding = vi.fn<(...args: unknown[]) => LandingPeek>(() => null);

vi.mock("@/services/cloudDeskExit", () => ({
  exportCloudDeskZip: (...args: unknown[]) => exportCloudDeskZip(...args),
  exportCloudDeskToPickedFolder: (...args: unknown[]) =>
    exportCloudDeskToPickedFolder(...args),
  registerMergeLanding: (...args: unknown[]) => registerMergeLanding(...args),
  mergeBackToLanding: (...args: unknown[]) => mergeBackToLanding(...args),
  mergeArtifactsOnlyToLanding: (...args: unknown[]) =>
    mergeArtifactsOnlyToLanding(...args),
  peekMergeLanding: (...args: unknown[]) => peekMergeLanding(...args),
}));

vi.mock("@/stores/folders", () => ({
  useFoldersStore: {
    getState: () => ({
      openImportToCloud: vi.fn(),
      openConnectGit: vi.fn(),
    }),
  },
}));

function cloudState(
  overrides?: Partial<WorkspaceModeState>,
): WorkspaceModeState {
  const effective: EffectiveWorkspace = {
    isLocal: false,
    rootId: null,
    rootName: null,
    rootMissing: false,
    viaContainer: false,
    projectName: "云项目",
    viaProject: true,
  };
  return {
    binding: {
      mode: "cloud",
      scope: "folder",
      rootId: null,
      source: "explicit",
    },
    roots: [{ id: "root-1", name: "desk" }],
    effective,
    refresh: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  exportCloudDeskZip.mockClear();
  exportCloudDeskToPickedFolder.mockClear();
  registerMergeLanding.mockClear();
  mergeBackToLanding.mockClear();
  mergeArtifactsOnlyToLanding.mockClear();
  peekMergeLanding.mockReturnValue(null);
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceModeMenu · cloud desk §7.6 exits", () => {
  it("shows ZIP / 导出到本机 / 登记合回落点 / 合回到本机 / 只合回产物 CTAs", () => {
    render(<WorkspaceModeMenu state={cloudState()} conversationId="c-cloud" />);

    expect(screen.getByText("导出 ZIP")).toBeTruthy();
    expect(screen.getByText("导出到本机文件夹")).toBeTruthy();
    expect(screen.getByText("登记合回落点")).toBeTruthy();
    expect(screen.getByText("合回到本机")).toBeTruthy();
    expect(screen.getByText("只合回产物")).toBeTruthy();
    expect(screen.queryByText("本地工作区")).toBeNull();
    expect(screen.queryByText("遗留：先改云拷贝再合回")).toBeNull();
    expect(screen.queryByText("后台云端")).toBeNull();
  });

  it("shows 更换合回落点 when landing is registered", () => {
    peekMergeLanding.mockReturnValue({
      rootId: "root-1",
      rootName: "desk",
      missing: false,
    });
    render(<WorkspaceModeMenu state={cloudState()} conversationId="c-cloud" />);
    expect(screen.getByText("更换合回落点")).toBeTruthy();
    expect(screen.getByText("当前 · desk")).toBeTruthy();
  });

  it("export ZIP click invokes cloudDeskExit", async () => {
    render(<WorkspaceModeMenu state={cloudState()} conversationId="c-cloud" />);
    fireEvent.click(screen.getByText("导出 ZIP"));
    await waitFor(() => {
      expect(exportCloudDeskZip).toHaveBeenCalledWith("c-cloud");
    });
  });

  it("export to folder click invokes cloudDeskExit", async () => {
    render(<WorkspaceModeMenu state={cloudState()} conversationId="c-cloud" />);
    fireEvent.click(screen.getByText("导出到本机文件夹"));
    await waitFor(() => {
      expect(exportCloudDeskToPickedFolder).toHaveBeenCalledWith("c-cloud");
    });
  });

  it("register landing click invokes cloudDeskExit", async () => {
    render(<WorkspaceModeMenu state={cloudState()} conversationId="c-cloud" />);
    fireEvent.click(screen.getByText("登记合回落点"));
    await waitFor(() => {
      expect(registerMergeLanding).toHaveBeenCalledWith("c-cloud");
    });
  });

  it("merge back click invokes cloudDeskExit with roots", async () => {
    const state = cloudState();
    render(<WorkspaceModeMenu state={state} conversationId="c-cloud" />);
    fireEvent.click(screen.getByText("合回到本机"));
    await waitFor(() => {
      expect(mergeBackToLanding).toHaveBeenCalledWith("c-cloud", state.roots);
    });
  });

  it("merge artifacts only click invokes cloudDeskExit with roots", async () => {
    const state = cloudState();
    render(<WorkspaceModeMenu state={state} conversationId="c-cloud" />);
    fireEvent.click(screen.getByText("只合回产物"));
    await waitFor(() => {
      expect(mergeArtifactsOnlyToLanding).toHaveBeenCalledWith(
        "c-cloud",
        state.roots,
      );
    });
  });
});
