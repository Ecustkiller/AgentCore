import { useApprovalStore } from "@/stores/approvals";
import { useConversationStore } from "@/stores/conversation";
import { frameFromEvent, useExecutionStore } from "@/stores/execution";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import type {
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  QuestionPostedPayload,
  SSEEvent,
} from "@/types/events";
import { flushPendingContent } from "../contentBuffer";
import { flushPendingFrames } from "../execFrameBuffer";
import { execMessageId } from "../helpers";
import type { DispatchContext } from "../types";

export function handleInteractionEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  const { conversationId } = ctx;

  switch (event.type) {
    case "approval_required": {
      useApprovalStore.getState().add(event.payload as ApprovalRequiredPayload);
      return true;
    }
    case "approval_resolved": {
      useApprovalStore
        .getState()
        .remove((event.payload as ApprovalResolvedPayload).approval_id);
      return true;
    }
    case "checkpoint_required": {
      // Flush buffered content first so the checkpoint marker anchors AFTER the CEO's
      // preceding line (统一团队时间线; matches the conformance golden's step order).
      flushPendingContent(conversationId);
      flushPendingFrames(conversationId);
      useConversationStore
        .getState()
        .addCheckpoint(
          event.payload as CheckpointRequiredPayload,
          conversationId,
        );
      return true;
    }
    case "checkpoint_resolved": {
      const p = event.payload as CheckpointResolvedPayload;
      useConversationStore
        .getState()
        .settleCheckpoint(
          p.checkpoint_id,
          p.decision,
          p.note ?? "",
          p.selected ?? [],
          conversationId,
        );
      // The live resolve deleted the durable frame server-side; mirror it so a
      // 待恢复 card from a duplicate surface can't linger and 404 on click.
      usePausedTurnStore.getState().removeByCheckpoint(p.checkpoint_id);
      return true;
    }
    case "question_posted": {
      flushPendingContent(conversationId);
      flushPendingFrames(conversationId);
      useConversationStore
        .getState()
        .addNonBlockingAsk(
          event.payload as QuestionPostedPayload,
          conversationId,
        );
      return true;
    }
    case "plan_review_required": {
      flushPendingContent(conversationId);
      // Land buffered worker frames before this checkpoint frame so the gated node's prior
      // deltas fold in first (帧顺序), then record the pause frame immediately.
      flushPendingFrames(conversationId);
      useConversationStore
        .getState()
        .addPlanReview(
          event.payload as PlanReviewRequiredPayload,
          conversationId,
        );
      {
        const mid = execMessageId(conversationId);
        const frame = frameFromEvent(event);
        if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      }
      return true;
    }
    case "plan_review_resolved": {
      const p = event.payload as PlanReviewResolvedPayload;
      useConversationStore
        .getState()
        .settlePlanReview(
          p.checkpoint_id,
          p.decision,
          p.note ?? "",
          conversationId,
        );
      // The live resolve deleted the durable frame server-side; mirror it so a
      // 待恢复 card from a duplicate surface can't linger and 404 on click.
      usePausedTurnStore.getState().removeByCheckpoint(p.checkpoint_id);
      flushPendingFrames(conversationId);
      {
        const mid = execMessageId(conversationId);
        const frame = frameFromEvent(event);
        if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      }
      return true;
    }
    default:
      return false;
  }
}
