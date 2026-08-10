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
    projectName: "本机项目",
    viaProject: true,
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
    busy: false,
    error: null,
    backingUp: false,
    backupDone: false,
    backup: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
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

describe("WorkspaceModeMenu · local traditional import CTA", () => {
  it("healthy local: quiet 导入本机项目到云 opens import with root prefill; 备份到云 secondary", () => {
    const state = healthyLocalState();
    render(<WorkspaceModeMenu state={state} conversationId="c1" />);

    expect(screen.getByText("导入本机项目到云")).toBeTruthy();
    expect(screen.queryByText("迁移到云")).toBeNull();
    expect(screen.getByText("备份到云")).toBeTruthy();
    expect(screen.queryByText(/请迁移到云后再继续/)).toBeNull();

    fireEvent.click(screen.getByText("导入本机项目到云"));
    expect(useFoldersStore.getState().importToCloudOpen).toBe(true);
    expect(useFoldersStore.getState().importToCloudPrefill).toEqual({
      rootId: "root-1",
      projectName: "本机项目",
    });
  });

  it("root-missing local: honest prompt + 导入本机项目到云 (not migrate debt copy)", () => {
    const state = healthyLocalState({
      effective: {
        isLocal: true,
        rootId: "root-gone",
        rootName: null,
        rootMissing: true,
        viaContainer: false,
        projectName: "本机项目",
        viaProject: true,
      },
    });
    render(<WorkspaceModeMenu state={state} conversationId="c1" />);
    expect(
      screen.getByText(/目录在本机不可用。请导入本机项目到云或重新绑定/),
    ).toBeTruthy();
    expect(screen.getByText("导入本机项目到云")).toBeTruthy();
    expect(screen.queryByText("迁移到云")).toBeNull();
    expect(screen.queryByText("备份到云")).toBeNull();
  });
});
