import { handleWorkspaceEvent } from "@/services/sse/handlers/workspace";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { notifyWarning, showWorkspace, performWorkspaceOp } = vi.hoisted(() => ({
  notifyWarning: vi.fn(),
  showWorkspace: vi.fn(),
  performWorkspaceOp: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ notifyWarning }));
vi.mock("@/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/workspaceOps", () => ({ performWorkspaceOp }));
vi.mock("@/stores/sidePanel", () => ({
  useSidePanelStore: {
    getState: () => ({ showWorkspace }),
  },
}));
vi.mock("@/stores/conversation/turnPhaseActions", () => ({
  getTurnPhase: () => "completed",
}));

describe("handleWorkspaceEvent auto-snapshot", () => {
  beforeEach(() => {
    notifyWarning.mockReset();
    showWorkspace.mockReset();
    useAutoSnapshotStore.setState({
      failedByConversation: {},
      openSnapshotsFor: null,
    });
  });

  it("marks failure, toasts, and opens snapshots on action", () => {
    const handled = handleWorkspaceEvent(
      {
        type: "workspace_snapshot_failed",
        payload: { conversation_id: "c1" },
      } as never,
      { conversationId: "c1", source: "live" } as never,
    );
    expect(handled).toBe(true);
    expect(useAutoSnapshotStore.getState().failedByConversation.c1).toBe(true);
    expect(notifyWarning).toHaveBeenCalledWith(
      "本回合自动备份失败",
      expect.objectContaining({
        description: "回合已完成；重要节点请手动留版本。",
      }),
    );
    const action = notifyWarning.mock.calls[0]?.[1]?.action;
    action?.onClick();
    expect(showWorkspace).toHaveBeenCalled();
    expect(useAutoSnapshotStore.getState().openSnapshotsFor).toBe("c1");
  });

  it("clears failure on done", () => {
    useAutoSnapshotStore.getState().markFailed("c1");
    const handled = handleWorkspaceEvent(
      {
        type: "workspace_snapshot_done",
        payload: {
          conversation_id: "c1",
          snapshot_id: "s1",
          size_bytes: 12,
        },
      } as never,
      { conversationId: "c1", source: "live" } as never,
    );
    expect(handled).toBe(true);
    expect(useAutoSnapshotStore.getState().failedByConversation.c1).toBeUndefined();
    expect(notifyWarning).not.toHaveBeenCalled();
  });
});
