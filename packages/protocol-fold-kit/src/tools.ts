/**
 * Protocol tool-name sets shared by desktop / mobile folds (and mirrored by the
 * Python sink / oracle). Pure data + predicates only — not a fold implementation.
 *
 * Keep in lockstep with `apps/server/agentcore/runtime/events/sink.py`
 * (`ORCHESTRATION_TOOLS` / `MARKER_STANDIN_TOOLS`); `pnpm conformance` is the gate.
 */

/** Tools that hand the turn to a sub-team: captain call is stood in by a `team` marker. */
export const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "delegate",
  "debate",
]);

/** Whether a tool name hands the turn to a sub-team (see {@link ORCHESTRATION_TOOLS}). */
export function isOrchestrationTool(toolName: string): boolean {
  return ORCHESTRATION_TOOLS.has(toolName);
}

/**
 * CEO self-calls whose inline-timeline slot is stood in for by a dedicated marker
 * (no captain `tool` step): delegate/debate → `team`; ask_user → `checkpoint`/`ask`.
 * Superset of {@link ORCHESTRATION_TOOLS}.
 */
export const MARKER_STANDIN_TOOLS: ReadonlySet<string> = new Set([
  ...ORCHESTRATION_TOOLS,
  "ask_user",
]);

/**
 * Whether a captain tool's timeline slot is represented by a marker, not a tool step
 * (see {@link MARKER_STANDIN_TOOLS}).
 */
export function isMarkerStandinTool(toolName: string): boolean {
  return MARKER_STANDIN_TOOLS.has(toolName);
}
