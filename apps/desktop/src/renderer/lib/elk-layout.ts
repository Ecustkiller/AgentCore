import type { GraphEdge } from "@/stores/graph";
import ELK from "elkjs/lib/elk.bundled";

const elk = new ELK();

const NODE_WIDTH = 210;
const NODE_HEIGHT = 110;

/**
 * Lay out a DAG with ELK and return positions keyed by node id.
 *
 * Takes only the graph *shape* (ids + edges) so callers can recompute layout
 * solely when structure changes, never on per-token data updates.
 */
export async function computeLayout(
  nodeIds: string[],
  edges: GraphEdge[],
): Promise<Record<string, { x: number; y: number }>> {
  if (nodeIds.length === 0) return {};

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "50",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
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

  const layout = await elk.layout(graph);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const child of layout.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }
  return positions;
}

export { NODE_WIDTH, NODE_HEIGHT };
