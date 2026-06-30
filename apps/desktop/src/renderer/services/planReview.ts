/** The decisions a user can actively make on a plan_review card (结构化挂起): `continue`
 * runs the gated downstream steps as-is, `adjust` injects the note as a steer onto them
 * and then runs them, `stop` ends the run here. `timeout` is engine-only, so it is never
 * sent by the client.
 *
 * 挂起即收口 (②, Phase 3): the live in-process `plan_review` resolve was retired — the
 * WaveScheduler now finalizes the turn at a checkpoint boundary and it is continued via
 * the single cold `POST .../resume` path (services/turns.ts `runResume`), never a
 * `POST .../interactions` from here. This module therefore no longer ships a
 * `decidePlanReview`; only the decision type survives, consumed by the durable resume
 * card (ResumePrompt) and the resume/stream services. */
export type PlanReviewUserDecision = "continue" | "adjust" | "stop";
