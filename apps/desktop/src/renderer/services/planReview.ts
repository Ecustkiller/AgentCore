/** Decisions a user can actively make on a plan_review / kickoff card.
 * plan_review: `continue` / `adjust` / `stop`.
 * team_preview (开工卡): `continue` (= grant + start) / `per_call` / `adjust` / `stop`.
 * `timeout` is engine-only and never sent by the client.
 *
 * Settlement is cold `POST .../resume` (services/turns.ts `runResume`). */
export type PlanReviewUserDecision =
  | "continue"
  | "per_call"
  | "adjust"
  | "stop";
