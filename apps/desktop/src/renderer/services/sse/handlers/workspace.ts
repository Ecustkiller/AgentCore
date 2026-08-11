import { logEvent } from "@/lib/log";
import { notifyWarning } from "@/lib/toast";
import { performWorkspaceOp } from "@/services/workspaceOps";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import { getTurnPhase } from "@/stores/conversation/turnPhaseActions";
import { useSidePanelStore } from "@/stores/sidePanel";
import type {
  SSEEvent,
  WorkspaceOpRequiredPayload,
  WorkspaceSnapshotDonePayload,
  WorkspaceSnapshotFailedPayload,
} from "@/types/events";
import type { DispatchContext } from "../types";

export function handleWorkspaceEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  switch (event.type) {
    case "workspace_op_required": {
      const payload = event.payload as WorkspaceOpRequiredPayload;
      const args = payload.args ?? {};
      // L3：落 args 里的路径键（无正文）；便于对照 NotADirectory / channel-dead。
      logEvent("info", "workspace_op.received", {
        conversation_id: ctx.conversationId,
        request_id: payload.request_id,
        op: payload.op,
        root_id: payload.root_id,
        timeout_ms: payload.timeout_ms,
        turn_phase: getTurnPhase(ctx.conversationId),
        source: ctx.source,
        args_directory:
          typeof args.directory === "string" ? args.directory : null,
        args_path: typeof args.path === "string" ? args.path : null,
        args_pattern: typeof args.pattern === "string" ? args.pattern : null,
        args_keys: Object.keys(args).sort(),
      });
      void performWorkspaceOp(payload, ctx.conversationId);
      return true;
    }
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
