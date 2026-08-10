// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import { LOCAL_TRADITIONAL_LABEL } from "@/lib/conversationWorkspaceMode";
import type { FolderMeta } from "@/services/folders";
import { useFoldersStore } from "@/stores/folders";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceGroupHeader } from "../WorkspaceGroupHeader";

vi.mock("@/hooks/useConversations", () => ({
  useArchiveConversation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useFolders", () => ({
  useDeleteFolder: () => ({ mutate: vi.fn() }),
  usePermanentDeleteFolder: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/newConversation", () => ({
  startNewConversation: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));
vi.mock("@/stores/conversation", () => ({
  useConversationStore: (
    sel: (s: {
      currentConversationId: null;
      dropConversationRuntime: () => void;
    }) => unknown,
  ) =>
    sel({
      currentConversationId: null,
      dropConversationRuntime: vi.fn(),
    }),
}));

function folder(mode: "local" | "cloud"): FolderMeta {
  return {
    id: "f1",
    name: "DemoProj",
    mode,
    localRootId: mode === "local" ? "root-1" : null,
    localSubpath: mode === "local" ? "" : null,
  };
}

function renderHeader(
  mode: "local" | "cloud",
  onToggleExpanded: () => void = () => {},
) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <WorkspaceGroupHeader
          folder={folder(mode)}
          convs={[]}
          expanded
          onToggleExpanded={onToggleExpanded}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useFoldersStore.setState({
    importToCloudOpen: false,
    importToCloudPrefill: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceGroupHeader · local traditional (no migrate debt badge)", () => {
  it("local group shows 本机传统 icon, no 请迁移 badge", () => {
    renderHeader("local");
    expect(screen.getByText("DemoProj")).toBeTruthy();
    expect(screen.getByLabelText(LOCAL_TRADITIONAL_LABEL)).toBeTruthy();
    expect(screen.queryByText("请迁移")).toBeNull();
    expect(screen.getByLabelText("在本机项目中新开对话")).toBeTruthy();
  });

  it("cloud group has no import menu entry", async () => {
    renderHeader("cloud");
    expect(screen.getByText("DemoProj")).toBeTruthy();
    expect(screen.queryByText("请迁移")).toBeNull();
    expect(screen.getByLabelText("云端")).toBeTruthy();
    expect(screen.getByLabelText("在云项目中新开对话")).toBeTruthy();

    const trigger = screen.getByLabelText("项目操作");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByText("新建对话")).toBeTruthy();
    expect(screen.queryByText("导入本机项目到云")).toBeNull();
  });

  it("⋯ menu 导入本机项目到云 opens import with prefill", async () => {
    renderHeader("local");
    const trigger = screen.getByLabelText("项目操作");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const item = await screen.findByText("导入本机项目到云");
    fireEvent.click(item);
    const state = useFoldersStore.getState();
    expect(state.importToCloudOpen).toBe(true);
    expect(state.importToCloudPrefill).toEqual({
      rootId: "root-1",
      projectName: "DemoProj",
    });
  });
});
