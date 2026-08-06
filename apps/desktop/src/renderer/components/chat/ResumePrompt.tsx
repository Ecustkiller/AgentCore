/**
 * Cold-path resume shell — thin re-export so callers keep
 * `@/components/chat/ResumePrompt` / `./ResumePrompt`.
 *
 * Implementation lives under `./resume/` aligned with hot cards
 * (`PlanReviewCard` / `TeamPreviewCard` / `CheckpointCard` + `ask/`).
 */
export { ResumePrompt } from "./resume/ResumePrompt";
