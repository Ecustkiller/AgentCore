import type { CheckpointDecision } from "@/types/events";

/** The decisions a user can actively make on an ask_user checkpoint card. `timeout`
 * is engine-only (a no-answer deadline) and is never sent by the client.
 *
 * 挂起即收口 (②, Phase 3): the live in-process `ask_user` resolve was retired — a CEO
 * checkpoint now finalizes the turn (`SUSPEND → PAUSED`) and is continued via the single
 * cold `POST .../resume` path (services/turns.ts `runResume`), never a
 * `POST .../interactions` from here. This module therefore no longer ships a
 * `decideCheckpoint`; only the decision type survives, still consumed by the shared
 * ask_user card body ({@link AskUserCard}) that the durable resume card (ResumePrompt)
 * reuses. */
export type CheckpointUserDecision = Exclude<CheckpointDecision, "timeout">;
