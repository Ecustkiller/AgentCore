import { useApprovalStore } from "@/stores/approvals";
import { useConversationStore } from "@/stores/conversation";
import { frameFromEvent, useExecutionStore } from "@/stores/execution";
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
      return true;
    }
    case "question_posted": {
      useConversationStore
        .getState()
        .addNonBlockingAsk(
          event.payload as QuestionPostedPayload,
          conversationId,
        );
      return true;
    }
    case "plan_review_required": {
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
