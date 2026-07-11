import type {
  InteractionKind,
  InteractionStatus,
} from "@/types/interactionExt";

/** One user-facing interaction card in the unified store (方案 §3.2). */
export interface InteractionEntry {
  id: string;
  kind: InteractionKind;
  status: InteractionStatus;
  conversationId: string;
  messageId: string;
  /** Original `*_required` (or question_posted) wire payload. */
  payload: Record<string, unknown>;
  /** Settlement payload when status is resolved (kind-specific). */
  resolution?: Record<string, unknown>;
}

export type InteractionSubmitPath = "cold" | "hot" | "compose";

/** Declarative kind → how the answer continues the turn. */
export const INTERACTION_SUBMIT_PATH: Record<
  InteractionKind,
  InteractionSubmitPath
> = {
  ask_user: "cold",
  plan_review: "cold",
  team_preview: "cold",
  approval: "hot",
  delegation_authorization: "hot",
  escalation: "hot",
  debate_round: "hot",
  question_posted: "compose",
};

/** Kind → id field on the `*_required` wire payload. */
export const INTERACTION_ID_FIELD: Record<InteractionKind, string> = {
  approval: "approval_id",
  delegation_authorization: "authorization_id",
  escalation: "escalation_id",
  debate_round: "decision_id",
  ask_user: "checkpoint_id",
  plan_review: "checkpoint_id",
  team_preview: "checkpoint_id",
  question_posted: "ask_id",
};

export function idFromRequiredPayload(
  kind: InteractionKind,
  payload: Record<string, unknown>,
): string | null {
  const field = INTERACTION_ID_FIELD[kind];
  const raw = payload[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function kindFromRequiredEvent(
  eventType: string,
): InteractionKind | null {
  switch (eventType) {
    case "approval_required":
      return "approval";
    case "delegation_authorization_required":
      return "delegation_authorization";
    case "escalation_required":
      return "escalation";
    case "debate_round_decision_required":
      return "debate_round";
    case "checkpoint_required":
      return "ask_user";
    case "plan_review_required":
      return "plan_review";
    case "team_preview_required":
      return "team_preview";
    case "question_posted":
      return "question_posted";
    default:
      return null;
  }
}

export function kindFromResolvedEvent(
  eventType: string,
): InteractionKind | null {
  switch (eventType) {
    case "approval_resolved":
      return "approval";
    case "delegation_authorization_resolved":
      return "delegation_authorization";
    case "escalation_resolved":
      return "escalation";
    case "debate_round_decision_resolved":
      return "debate_round";
    case "checkpoint_resolved":
      return "ask_user";
    case "plan_review_resolved":
      return "plan_review";
    case "team_preview_resolved":
      return "team_preview";
    default:
      return null;
  }
}

export function idFromResolvedPayload(
  kind: InteractionKind,
  payload: Record<string, unknown>,
): string | null {
  if (kind === "debate_round") {
    const id = payload.decision_id ?? payload.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return idFromRequiredPayload(kind, payload);
}
