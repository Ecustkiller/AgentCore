/**
 * Desktop interaction-store kinds beyond the hot-path recovery summary.
 * Hot-path recovery shapes live in `@agentcore/contract-rest-types` (generated).
 */

/** Wire kinds that participate in the unified InteractionStore (方案 §3.2). */
export type InteractionKind =
  | "approval"
  | "delegation_authorization"
  | "escalation"
  | "ask_user"
  | "plan_review"
  | "team_preview"
  | "question_posted";

export type InteractionStatus =
  | "pending"
  | "submitting"
  | "resolved"
  | "orphaned";

/** New SSE fact: a pending interaction is no longer answerable. */
export interface InteractionOrphanedPayload {
  interaction_id: string;
  kind: InteractionKind;
}

export const INTERACTION_ORPHANED_EVENT = "interaction_orphaned" as const;

export function isInteractionOrphanedEvent(type: string): boolean {
  return type === INTERACTION_ORPHANED_EVENT;
}
