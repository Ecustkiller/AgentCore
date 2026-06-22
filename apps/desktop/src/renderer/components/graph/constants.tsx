/** Synthetic graph bookend id and ReactFlow node/edge type maps. */

import type { GraphLayout } from "@/stores/graph";
import { ListTree, MoveHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { AgentNode } from "./AgentNode";
import { EndpointNode } from "./EndpointNode";
import { StepEdge } from "./StepEdge";

export const INPUT_ID = "__input__";

export const isEndpointId = (id: string): boolean => id === INPUT_ID;

/** An endpoint (用户输入 / CEO 汇聚点) read in place: the chat message to surface
 * (the prompt / the CEO's final answer) + its drawer title. Its content is a chat
 * bubble (not a run), so it rides local component state rather than the shared
 * run-detail panel. Consumed by the canvas focused node + zoomed-turn foot drawer. */
export interface EndpointView {
  contentMessageId: string;
  title: string;
}

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
