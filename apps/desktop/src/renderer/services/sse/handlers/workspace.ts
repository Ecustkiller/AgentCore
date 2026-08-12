import { notifyWarning } from "@/lib/toast";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import { useSidePanelStore } from "@/stores/sidePanel";
import type {
  SSEEvent,
  WorkspaceSnapshotDonePayload,
  WorkspaceSnapshotFailedPayload,
} from "@/types/events";
import type { DispatchContext } from "../types";

/**
 * Conversation-bus workspace events that are **not** CLIENT_TOOL fulfill.
 * `workspace_op_required` is handled in `dispatchSSEEvent` (sidecar only) /
 * device fulfill ingress (cloud) — not here.
 */
export function handleWorkspaceEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  switch (event.type) {
    case "workspace_snapshot_done": {
      const payload = event.payload as WorkspaceSnapshotDonePayload;
      const conversationId = payload.conversation_id || ctx.conversationId;
      useAutoSnapshotStore.getState().clearFailed(conversationId);
      return true;
    }
    case "workspace_snapshot_failed": {
      const payload = event.payload as WorkspaceSnapshotFailedPayload;
      const conversationId = payload.conversation_id || ctx.conversationId;
      useAutoSnapshotStore.getState().markFailed(conversationId);
      notifyWarning("本回合自动备份失败", {
        description: "回合已完成；重要节点请手动留版本。",
        action: {
          label: "查看快照",
          onClick: () => {
            useSidePanelStore.getState().showWorkspace();
            useAutoSnapshotStore
              .getState()
              .requestOpenSnapshots(conversationId);
          },
        },
      });
      return true;
    }
    default:
      return false;
  }
}
