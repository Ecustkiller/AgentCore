import { performWorkspaceOp } from "@/services/workspaceOps";
import { applyConversationPromotion } from "@/services/workspacePromotion";
import type { SSEEvent, WorkspaceOpRequiredPayload, WorkspacePromotedPayload } from "@/types/events";
import type { DispatchContext } from "../types";

export function handleWorkspaceEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  switch (event.type) {
    case "workspace_op_required": {
      void performWorkspaceOp(
        event.payload as WorkspaceOpRequiredPayload,
        ctx.conversationId,
      );
      return true;
    }
    case "workspace_promoted": {
      const p = event.payload as WorkspacePromotedPayload;
      applyConversationPromotion(p.conversation_id, {
        id: p.folder_id,
        name: p.name,
        localDir: null,
        localRootId: p.local_root_id,
        localSubpath: p.local_subpath,
      });
      return true;
    }
    default:
      return false;
  }
}
