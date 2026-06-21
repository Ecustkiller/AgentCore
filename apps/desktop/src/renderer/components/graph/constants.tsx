/** Synthetic graph bookend id and ReactFlow node/edge type maps. */

import type { ReactNode } from "react";
import { ListTree, MoveHorizontal } from "lucide-react";
import type { GraphLayout } from "@/stores/graph";
import { AgentNode } from "./AgentNode";
import { EndpointNode } from "./EndpointNode";
import { StepEdge } from "./StepEdge";

export const INPUT_ID = "__input__";

export const isEndpointId = (id: string): boolean => id === INPUT_ID;

export const nodeTypes = {
  agent: AgentNode,
  userInput: EndpointNode,
  captain: EndpointNode,
};

export const edgeTypes = { step: StepEdge };

export const LAYOUT_OPTIONS: {
  kind: GraphLayout;
  label: string;
  icon: ReactNode;
}[] = [
  { kind: "leftright", label: "左右流", icon: <MoveHorizontal size={14} /> },
  { kind: "tree", label: "树形布局", icon: <ListTree size={14} /> },
];

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
