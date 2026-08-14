import { notifyConversationWorkspaceTree } from "@/components/files/notifyConversationWorkspaceTree";
import { notifyWarning } from "@/lib/toast";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
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
      if (ctx.replay !== true) {
        notifyConversationWorkspaceTree(conversationId);
      }
      return true;
    }
    case "workspace_snapshot_failed": {
      const payload = event.payload as WorkspaceSnapshotFailedPayload;
      const conversationId = payload.conversation_id || ctx.conversationId;
      useAutoSnapshotStore.getState().markFailed(conversationId);
      notifyWarning("本回合自动备份失败", {
        description: "回合已完成；下次改文件的回合会再试。",
      });
      return true;
    }
    default:
      return false;
  }
}
