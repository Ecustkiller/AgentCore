import { performWorkspaceOp } from "@/services/workspaceOps";
import { applyConversationPromotion } from "@/services/workspacePromotion";
import { useConversationStore } from "@/stores/conversation";
import type {
  SSEEvent,
  WorkspaceOpRequiredPayload,
  WorkspacePromotedPayload,
} from "@/types/events";
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
      // P2 工作区升级提示 (前端UX设计.md §九): stamp the live turn's assistant
      // bubble so it shows an inline「已升级为工作区」notice. Live-only — the stamp
      // rides the in-flight message and is never journaled.
      useConversationStore
        .getState()
        .attachWorkspacePromotionToLastMessage(
          { folderId: p.folder_id, name: p.name },
          p.conversation_id,
        );
      return true;
    }
    default:
      return false;
  }
}
