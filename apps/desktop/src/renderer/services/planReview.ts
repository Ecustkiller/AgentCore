/** Decisions a user can actively make on a plan_review card: `continue` runs
 * gated steps as-is, `adjust` injects a steer then runs, `stop` ends here.
 * `timeout` is engine-only and never sent by the client.
 *
 * Settlement is cold `POST .../resume` (services/turns.ts `runResume`). */
export type PlanReviewUserDecision = "continue" | "adjust" | "stop";
