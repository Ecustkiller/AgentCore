import { create } from "zustand";

/** Structural edge (DAG dependency). Visual state (animated) is derived live. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

interface GraphState {
  /** ELK-computed positions keyed by step id. Recomputed only on shape change. */
  positions: Record<string, { x: number; y: number }>;
  edges: GraphEdge[];

  setLayout: (
    positions: Record<string, { x: number; y: number }>,
    edges: GraphEdge[],
  ) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  positions: {},
  edges: [],

  setLayout: (positions, edges) => set({ positions, edges }),
}));
