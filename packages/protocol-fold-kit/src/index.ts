/**
 * @agentcore/protocol-fold-kit — shared protocol fold *constants / pure predicates*
 * for desktop + mobile. Does **not** ship `fold(events)→ProjectedTurn`.
 *
 * 「用时」跨度（{@link turnElapsedMs}）也在这里：它是同名指标，两端算的必须是同一个量。
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

export {
  RUN_FRAME_EVENT_TYPES,
  isRunFrameEvent,
  turnElapsedMs,
  type TimedWireEvent,
} from "./turnElapsed";
