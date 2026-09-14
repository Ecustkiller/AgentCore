import type { CaptainOverride, GraphEvalSpec, GraphState } from "../../core/graph/graphState";
import { buildGraphState } from "../../core/graph/graphState";
import {
  CAPTAIN_ID,
  DEMO_LAYOUT_EDGES,
  DEMO_NODES,
  INPUT_ID,
} from "./demo";
import { DEMO_LAYOUT } from "./layout";
import {
  CAPTAIN_ENTER,
  DEBATE_AXIS,
  DURATION_MS,
  INPUT_ENTER,
  SCHED,
  STREAM,
} from "./schedule";

/** Sample collaboration graph for stills / Studio (not a finished film). */
export const HERO_GRAPH_SPEC: GraphEvalSpec = {
  nodes: DEMO_NODES,
  edges: DEMO_LAYOUT_EDGES,
  positions: DEMO_LAYOUT.positions,
  sched: SCHED,
  stream: STREAM,
  durationMs: DURATION_MS,
  inputId: INPUT_ID,
  captainId: CAPTAIN_ID,
  inputEnter: INPUT_ENTER,
  captainEnter: CAPTAIN_ENTER,
  debate: DEBATE_AXIS,
};

export function buildHeroGraphState(
  frame: number,
  fps: number,
  opts: { captain?: CaptainOverride } = {},
): GraphState {
  return buildGraphState(frame, fps, HERO_GRAPH_SPEC, opts);
}
