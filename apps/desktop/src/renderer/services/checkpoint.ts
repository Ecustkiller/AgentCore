import type { CheckpointDecision } from "@/types/events";

/** Decisions a user can actively send on an ask_user card. `timeout` /
 * `orphaned` are engine-only and never sent by the client. `adjust` remains
 * leftover vocabulary (ask_user rejects it).
 *
 * Settlement is cold `POST .../resume` (services/turns.ts `runResume`); the
 * shared ask_user body ({@link AskUserCard}) is reused by ResumePrompt. */
export type CheckpointUserDecision = Exclude<
  CheckpointDecision,
  "timeout" | "orphaned"
>;
