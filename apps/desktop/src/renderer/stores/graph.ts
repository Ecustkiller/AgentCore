import { create } from "zustand";

/** Structural edge (DAG dependency). Visual state (animated) is derived live. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Collaboration-graph layout algorithm (user-switchable via the canvas menu).
 * `tree` is the default top-down layered flow; `leftright` is the same layered
 * algorithm rotated; `radial` arranges the team around the root; `force` is a
 * physics simulation that lets densely-connected teams settle organically.
 */
export type GraphLayout = "tree" | "leftright" | "radial" | "force";

const LAYOUT_KEY = "agentcore:graph-layout";
const LAYOUTS: GraphLayout[] = ["tree", "leftright", "radial", "force"];

// localStorage is wrapped: it throws in private-mode / non-DOM (test) contexts.
function loadLayout(): GraphLayout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v && (LAYOUTS as string[]).includes(v) ? (v as GraphLayout) : "tree";
  } catch {
    return "tree";
  }
}

function persistLayout(v: GraphLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, v);
  } catch {
    /* unavailable — session-only */
  }
}

interface GraphState {
  /** ELK-computed positions keyed by run id. Recomputed only on shape change. */
  positions: Record<string, { x: number; y: number }>;
  edges: GraphEdge[];
  /** Active layout algorithm (persisted). */
  layoutKind: GraphLayout;

  setLayout: (
    positions: Record<string, { x: number; y: number }>,
    edges: GraphEdge[],
  ) => void;
  setLayoutKind: (kind: GraphLayout) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  positions: {},
  edges: [],
  layoutKind: loadLayout(),

  setLayout: (positions, edges) => set({ positions, edges }),
  setLayoutKind: (layoutKind) => {
    persistLayout(layoutKind);
    set({ layoutKind });
  },
}));
