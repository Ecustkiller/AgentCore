import { create } from "zustand";

/** Structural edge. Visual state (animated) is derived live.
 *
 * `dep` (default) is a DAG dependency / input·synthesis bookend flow; `delegate`
 * is a captain worker → its nested sub-worker (阶段2 父子分组), drawn distinctly
 * (dashed) so a sub-team reads as grouped under the parent rather than as another
 * top-level branch. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind?: "dep" | "delegate";
}

/**
 * Collaboration-graph layout algorithm (user-switchable from the canvas
 * toolbar). `leftright` is the default left-to-right layered flow — it suits the
 * widescreen displays the desktop targets and keeps the inline↔full-screen
 * direction consistent (no 90° flip on maximize); `tree` is the same layered
 * algorithm rotated top-down. Two layouts cover every DAG the MVP teams produce;
 * the earlier `radial` / `force` options added choice without value on small
 * teams (and `force` was the costliest to run), so they were dropped.
 */
export type GraphLayout = "tree" | "leftright";

const LAYOUT_KEY = "agentcore:graph-layout";
const LAYOUTS: GraphLayout[] = ["tree", "leftright"];

// localStorage is wrapped: it throws in private-mode / non-DOM (test) contexts.
function loadLayout(): GraphLayout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v && (LAYOUTS as string[]).includes(v)
      ? (v as GraphLayout)
      : "leftright";
  } catch {
    return "leftright";
  }
}

function persistLayout(v: GraphLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, v);
  } catch {
    /* unavailable — session-only */
  }
}

// Per-graph layout (ELK positions + structural edges) is NOT global state: with
// §9.3 every multi-agent message renders its own inline graph, so the layout is
// view state owned locally by each {@link GraphView}. Only the *choice* of layout
// algorithm is global — it is a user preference that applies to every graph and
// persists across sessions.
interface GraphState {
  /** Active layout algorithm — a shared, persisted user preference. */
  layoutKind: GraphLayout;
  setLayoutKind: (kind: GraphLayout) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  layoutKind: loadLayout(),

  setLayoutKind: (layoutKind) => {
    persistLayout(layoutKind);
    set({ layoutKind });
  },
}));
