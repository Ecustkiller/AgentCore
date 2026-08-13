import { handleWorkspaceEvent } from "@/services/sse/handlers/workspace";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { notifyWarning, showChanges, performWorkspaceOp } = vi.hoisted(() => ({
  notifyWarning: vi.fn(),
  showChanges: vi.fn(),
  performWorkspaceOp: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ notifyWarning }));
vi.mock("@/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/workspaceOps", () => ({ performWorkspaceOp }));
vi.mock("@/stores/sidePanel", () => ({
  useSidePanelStore: {
    getState: () => ({ showChanges }),
  },
}));
vi.mock("@/stores/conversation/turnPhaseActions", () => ({
  getTurnPhase: () => "completed",
}));

describe("handleWorkspaceEvent auto-snapshot", () => {
  beforeEach(() => {
    notifyWarning.mockReset();
    showChanges.mockReset();
    useAutoSnapshotStore.setState({ failedByConversation: {} });
  });

  it("marks failure, toasts, and opens the 改动 tab on action", () => {
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
    expect(action?.label).toBe("查看改动");
    action?.onClick();
    expect(showChanges).toHaveBeenCalled();
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
    expect(
      useAutoSnapshotStore.getState().failedByConversation.c1,
    ).toBeUndefined();
    expect(notifyWarning).not.toHaveBeenCalled();
  });
});
