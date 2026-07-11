import { useConversationStore } from "@/stores/conversation";
import { frameFromEvent, useExecutionStore } from "@/stores/execution";
import {
  applyInteractionWireEvent,
  useInteractionStore,
} from "@/stores/interactions";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import type {
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  QuestionPostedPayload,
  SSEEvent,
  TeamPreviewRequiredPayload,
  TeamPreviewResolvedPayload,
} from "@/types/events";
import {
  type InteractionOrphanedPayload,
  isInteractionOrphanedEvent,
} from "@/types/interactionExt";
import { flushPendingContent } from "../contentBuffer";
import { flushPendingFrames } from "../execFrameBuffer";
import { execMessageId } from "../helpers";
import type { DispatchContext } from "../types";

function wireIntoInteractionStore(
  event: SSEEvent,
  conversationId: string,
): void {
  const messageId = execMessageId(conversationId) ?? "";
  applyInteractionWireEvent(
    event.type,
    (event.payload ?? {}) as Record<string, unknown>,
    conversationId,
    messageId,
  );
}

export function handleInteractionEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  const { conversationId } = ctx;

  if (isInteractionOrphanedEvent(event.type)) {
    const p = event.payload as InteractionOrphanedPayload;
    useInteractionStore.getState().markOrphaned(p.interaction_id);
    return true;
  }

  switch (event.type) {
    case "approval_required":
    case "approval_resolved":
    case "delegation_authorization_required":
    case "delegation_authorization_resolved": {
      wireIntoInteractionStore(event, conversationId);
      return true;
    }
    case "checkpoint_required": {
      flushPendingContent(conversationId);
      flushPendingFrames(conversationId);
      wireIntoInteractionStore(event, conversationId);
      useConversationStore
        .getState()
        .stampCheckpointMarker(
          (event.payload as CheckpointRequiredPayload).checkpoint_id,
          conversationId,
        );
      return true;
    }
    case "checkpoint_resolved": {
      wireIntoInteractionStore(event, conversationId);
      const p = event.payload as CheckpointResolvedPayload;
      usePausedTurnStore.getState().removeByCheckpoint(p.checkpoint_id);
      return true;
    }
    case "question_posted": {
      flushPendingContent(conversationId);
      flushPendingFrames(conversationId);
      wireIntoInteractionStore(event, conversationId);
      useConversationStore
        .getState()
        .stampAskMarker(
          (event.payload as QuestionPostedPayload).ask_id,
          conversationId,
        );
      return true;
    }
    case "plan_review_required": {
      flushPendingContent(conversationId);
      flushPendingFrames(conversationId);
      wireIntoInteractionStore(event, conversationId);
      useConversationStore
        .getState()
        .stampPlanReviewMarker(
          (event.payload as PlanReviewRequiredPayload).checkpoint_id,
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
      wireIntoInteractionStore(event, conversationId);
      const p = event.payload as PlanReviewResolvedPayload;
      usePausedTurnStore.getState().removeByCheckpoint(p.checkpoint_id);
      flushPendingFrames(conversationId);
      {
        const mid = execMessageId(conversationId);
        const frame = frameFromEvent(event);
        if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      }
      return true;
    }
    case "team_preview_required": {
      flushPendingContent(conversationId);
      flushPendingFrames(conversationId);
      wireIntoInteractionStore(event, conversationId);
      useConversationStore
        .getState()
        .stampTeamPreviewMarker(
          (event.payload as TeamPreviewRequiredPayload).checkpoint_id,
          conversationId,
        );
      return true;
    }
    case "team_preview_resolved": {
      wireIntoInteractionStore(event, conversationId);
      const p = event.payload as TeamPreviewResolvedPayload;
      usePausedTurnStore.getState().removeByCheckpoint(p.checkpoint_id);
      return true;
    }
    default:
      return false;
  }
}
