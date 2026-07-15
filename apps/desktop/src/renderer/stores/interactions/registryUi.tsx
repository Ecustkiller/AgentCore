/**
 * UI bindings for {@link INTERACTION_REGISTRY} — card components + cold-resume
 * renderers. Kept separate from the data registry to avoid React cycles in
 * store / fold modules.
 */

import { CheckpointCard } from "@/components/chat/CheckpointCard";
import { NonBlockingAskCard } from "@/components/chat/NonBlockingAskCard";
import { PlanReviewCard } from "@/components/chat/PlanReviewCard";
import { TeamPreviewCard } from "@/components/chat/TeamPreviewCard";
import type {
  CheckpointDisplay,
  NonBlockingAskDisplay,
  PlanReviewDisplay,
  TeamPreviewDisplay,
} from "@/stores/conversation";
import type { ReactNode } from "react";
import type { TimelineProcessKind } from "./registry";

export type TimelineCardBags = {
  checkpoints: CheckpointDisplay[];
  nonBlockingAsks: NonBlockingAskDisplay[];
  planReviews: PlanReviewDisplay[];
  teamPreviews: TeamPreviewDisplay[];
};

type TimelineNodeId = {
  checkpoint_id?: string;
  ask_id?: string;
};

/**
 * Render the inline decision card for a timeline process marker, or null when
 * the matching display model is not yet hydrated.
 */
export function renderTimelineInteractionCard(
  processKind: TimelineProcessKind,
  node: TimelineNodeId,
  bags: TimelineCardBags,
): ReactNode {
  switch (processKind) {
    case "checkpoint": {
      const cp = bags.checkpoints.find((c) => c.id === node.checkpoint_id);
      return cp ? <CheckpointCard key={cp.id} checkpoint={cp} /> : null;
    }
    case "ask": {
      const ask = bags.nonBlockingAsks.find((a) => a.id === node.ask_id);
      return ask ? <NonBlockingAskCard key={ask.id} ask={ask} /> : null;
    }
    case "plan_review": {
      const pr = bags.planReviews.find((p) => p.id === node.checkpoint_id);
      return pr ? <PlanReviewCard key={pr.id} review={pr} /> : null;
    }
    case "team_preview": {
      const tp = bags.teamPreviews.find((p) => p.id === node.checkpoint_id);
      return tp ? <TeamPreviewCard key={tp.id} preview={tp} /> : null;
    }
  }
}
