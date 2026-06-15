import type { GraphEdge, GraphLayout } from "@/stores/graph";
import ELK from "elkjs/lib/elk.bundled";

const elk = new ELK();

const NODE_WIDTH = 210;
const NODE_HEIGHT = 110;

/**
 * Per-layout ELK options. Padding is shared and applied on top in computeLayout.
 *
 * NETWORK_SIMPLEX node placement centers a lone source/sink node on its branch
 * midline, so a 1→N fan-out (用户输入) and an N→1 fan-in (synthesis) stay
 * symmetric. The ELK default (BRANDES_KOEPF) packs the lone node onto the topmost
 * branch instead — that is why the input endpoint used to sit above center.
 */
const LAYOUT_OPTIONS: Record<GraphLayout, Record<string, string>> = {
  tree: {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.spacing.nodeNode": "50",
    "elk.layered.spacing.nodeNodeBetweenLayers": "90",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  },
  leftright: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.spacing.nodeNode": "50",
    "elk.layered.spacing.nodeNodeBetweenLayers": "110",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
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
