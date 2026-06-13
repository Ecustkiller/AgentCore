import { create } from "zustand";
import type { StepStatus } from "./execution";

export interface GraphNode {
  id: string;
  type: "agent";
  data: {
    agentId: string;
    role: string;
    stepId: string;
    status: StepStatus;
    isAnimating: boolean;
  };
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  animated: boolean;
}

interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;

  setNodes: (nodes: GraphNode[]) => void;
  setEdges: (edges: GraphEdge[]) => void;
  selectNode: (nodeId: string | null) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
}));
