/**
 * @agentcore/protocol-fold-kit — shared protocol fold *constants / pure predicates*
 * for desktop + mobile. Does **not** ship `fold(events)→ProjectedTurn`.
 *
 * Allowed under cross-platform-frontend: protocol constants yes; shared fold
 * implementation no. Gate remains `pnpm conformance`.
 */

export {
  ORCHESTRATION_TOOLS,
  isOrchestrationTool,
  MARKER_STANDIN_TOOLS,
  isMarkerStandinTool,
} from "./tools";

export {
  FINISH_TO_STATUS,
  turnStatusFromFinish,
  type FinishMappedStatus,
} from "./finishStatus";
