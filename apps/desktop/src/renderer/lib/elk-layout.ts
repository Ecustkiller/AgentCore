import type { GraphEdge, GraphLayout } from "@/stores/graph";
import ELK from "elkjs/lib/elk.bundled";

const elk = new ELK();

const NODE_WIDTH = 210;
const NODE_HEIGHT = 110;

/** Per-layout ELK options. Padding is shared and applied on top in computeLayout. */
const LAYOUT_OPTIONS: Record<GraphLayout, Record<string, string>> = {
  tree: {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.spacing.nodeNode": "50",
    "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  },
  leftright: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.spacing.nodeNode": "50",
    "elk.layered.spacing.nodeNodeBetweenLayers": "110",
  },
  radial: {
    "elk.algorithm": "radial",
    "elk.spacing.nodeNode": "60",
  },
  force: {
    "elk.algorithm": "force",
    // Wide nodes (210px) need generous repulsion or they overlap; iterations
    // are bounded so the simulation stays snappy for the ≤50-node target.
    "elk.spacing.nodeNode": "120",
    "elk.force.iterations": "300",
  },
};

/**
 * Lay out a DAG with ELK and return positions keyed by node id.
 *
 * Takes only the graph *shape* (ids + edges) plus the chosen {@link GraphLayout}
 * so callers recompute layout solely on structure / layout change, never on
 * per-token data updates.
 */
export async function computeLayout(
  nodeIds: string[],
  edges: GraphEdge[],
  layout: GraphLayout = "tree",
): Promise<Record<string, { x: number; y: number }>> {
  if (nodeIds.length === 0) return {};

  const graph = {
    id: "root",
    layoutOptions: {
      ...LAYOUT_OPTIONS[layout],
      "elk.padding": "[top=40,left=40,bottom=40,right=40]",
    },
    children: nodeIds.map((id) => ({
      id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const laidOut = await elk.layout(graph);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const child of laidOut.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }
  return positions;
}

export { NODE_WIDTH, NODE_HEIGHT };
