/** Synthetic graph bookend id and ReactFlow node/edge type maps. */

import type { GraphLayout } from "@/stores/graph";
import { ListTree, MoveHorizontal, Timer } from "lucide-react";
import type { ReactNode } from "react";
import { AgentNode } from "./AgentNode";
import { EndpointNode } from "./EndpointNode";
import { StepEdge } from "./StepEdge";
import { SubTeamGroupNode } from "./SubTeamGroupNode";

export const INPUT_ID = "__input__";

export const isEndpointId = (id: string): boolean => id === INPUT_ID;

export const nodeTypes = {
  agent: AgentNode,
  userInput: EndpointNode,
  captain: EndpointNode,
  subTeamGroup: SubTeamGroupNode,
};

export const edgeTypes = { step: StepEdge };

export const LAYOUT_OPTIONS: {
  kind: GraphLayout;
  label: string;
  icon: ReactNode;
  /** When true, only enabled if the turn has parallel timing data. */
  requiresParallelTimeline?: boolean;
}[] = [
  { kind: "leftright", label: "左右流", icon: <MoveHorizontal size={14} /> },
  { kind: "tree", label: "树形布局", icon: <ListTree size={14} /> },
  {
    kind: "timeline",
    label: "时间轴",
    icon: <Timer size={14} />,
    requiresParallelTimeline: true,
  },
];

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
