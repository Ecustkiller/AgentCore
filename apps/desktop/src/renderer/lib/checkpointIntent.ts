/** Unrecognized checkpoint intent (including retired ask shells) → decision. */
export type AskUiIntent = "decision";

/** Normalize wire/recovery `intent` — every pause uses the generic clarification chrome. */
export function parseCheckpointIntent(_raw: unknown): AskUiIntent {
  return "decision";
}
