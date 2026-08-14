import { notifyFileTreeChanged } from "@/components/files/fileTreeBus";
import { handleWorkspaceEvent } from "@/services/sse/handlers/workspace";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { notifyWarning, performWorkspaceOp } = vi.hoisted(() => ({
  notifyWarning: vi.fn(),
  performWorkspaceOp: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ notifyWarning }));
vi.mock("@/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/workspaceOps", () => ({ performWorkspaceOp }));
vi.mock("@/stores/conversation/turnPhaseActions", () => ({
  getTurnPhase: () => "completed",
}));
vi.mock("@/components/files/fileTreeBus", () => ({
  notifyFileTreeChanged: vi.fn(),
}));

describe("handleWorkspaceEvent auto-snapshot", () => {
  beforeEach(() => {
    notifyWarning.mockReset();
    vi.mocked(notifyFileTreeChanged).mockClear();
    useAutoSnapshotStore.setState({ failedByConversation: {} });
  });

  it("marks failure and toasts without version or changes-tab guidance", () => {
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
        description: "回合已完成；下次改文件的回合会再试。",
      }),
    );
    const opts = notifyWarning.mock.calls[0]?.[1];
    expect(opts?.action).toBeUndefined();
    expect(opts?.description).not.toMatch(/手动留版本/);
  });

  it("clears failure on done and notifies the conversation file tree", () => {
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
    expect(notifyFileTreeChanged).toHaveBeenCalledWith({
      sourceId: "workspace:c1",
      dir: "",
    });
  });

  it("does not notify the tree on replay", () => {
    handleWorkspaceEvent(
      {
        type: "workspace_snapshot_done",
        payload: {
          conversation_id: "c1",
          snapshot_id: "s1",
          size_bytes: 12,
        },
      } as never,
      { conversationId: "c1", source: "live", replay: true } as never,
    );
    expect(notifyFileTreeChanged).not.toHaveBeenCalled();
  });
});
