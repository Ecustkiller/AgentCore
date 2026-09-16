// @vitest-environment jsdom
import {
  WorkspaceModeMenu,
  type WorkspaceModeState,
} from "@/components/workspace/WorkspaceModeControl";
import type { EffectiveWorkspace } from "@/lib/workspaceEffectiveMode";
import { useFoldersStore } from "@/stores/folders";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: () => true,
}));

vi.mock("@/hooks/useConversations", () => ({
  getConversations: () => [],
}));

function healthyLocalState(
  overrides?: Partial<WorkspaceModeState>,
): WorkspaceModeState {
  const effective: EffectiveWorkspace = {
    isLocal: true,
    rootId: "root-1",
    rootName: "my-app",
    rootMissing: false,
    viaContainer: false,
    folderName: "本机项目",
    viaFolder: true,
  };
  return {
    binding: {
      mode: "local",
      scope: "folder",
      rootId: "root-1",
      source: "explicit",
    },
    roots: [{ id: "root-1", name: "my-app" }],
    effective,
    refresh: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useFoldersStore.setState({
    connectGitOpen: false,
    connectGitWsId: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceModeMenu · local traditional status", () => {
  it("healthy local: status only; no leftover handoff arm", () => {
    const state = healthyLocalState();
    render(<WorkspaceModeMenu state={state} conversationId="c1" />);

    expect(screen.getByText("文件夹 · 本机项目")).toBeTruthy();
    expect(screen.getByText("本机路径 · my-app")).toBeTruthy();
    expect(screen.queryByText("从 Git 克隆")).toBeNull();
    expect(screen.queryByText("迁移到云")).toBeNull();
    expect(screen.queryByText("遗留：先改云拷贝再合回")).toBeNull();
    expect(screen.queryByText("备份到云")).toBeNull();
    expect(screen.queryByText("后台云端")).toBeNull();
    expect(screen.queryByText(/请迁移到云后再继续/)).toBeNull();
  });

  it("root-missing local: honest rebind copy + Git clone (not migrate debt copy)", () => {
    const state = healthyLocalState({
      effective: {
        isLocal: true,
        rootId: "root-gone",
        rootName: null,
        rootMissing: true,
        viaContainer: false,
        folderName: "本机项目",
        viaFolder: true,
      },
    });
    render(<WorkspaceModeMenu state={state} conversationId="c1" />);
    expect(
      screen.getByText(/目录在本机不可用。请重新绑定本机路径后再继续/),
    ).toBeTruthy();
    expect(screen.getByText("从 Git 克隆")).toBeTruthy();
    expect(screen.queryByText("迁移到云")).toBeNull();
    expect(screen.queryByText("遗留：先改云拷贝再合回")).toBeNull();
    expect(screen.queryByText("备份到云")).toBeNull();

    fireEvent.click(screen.getByText("从 Git 克隆"));
    expect(useFoldersStore.getState().connectGitOpen).toBe(true);
  });
});
