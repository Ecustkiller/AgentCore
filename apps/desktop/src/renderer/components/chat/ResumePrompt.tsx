/**
 * Cold-path resume shell — thin re-export so callers keep
 * `@/components/chat/ResumePrompt` / `./ResumePrompt`.
 *
 * Implementation lives under `./resume/` aligned with hot cards
 * (`CheckpointCard` + `ask/`；冷 resume 只画 ask_user).
 */
export { ResumePrompt } from "./resume/ResumePrompt";
