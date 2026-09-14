import { AgentNode } from "@/components/graph/AgentNode";
import { EndpointNode } from "@/components/graph/EndpointNode";
import { StepEdge } from "@/components/graph/StepEdge";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Background,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { DEMO_DEBATE_EDGES, DEMO_LAYOUT_EDGES, DEMO_NODES } from "./hero/demo";
import { DEMO_LAYOUT } from "./hero/layout";
import { HEIGHT, WIDTH } from "./constants";

/**
 * Pixel check — real AgentNode / EndpointNode / StepEdge on the sample DAG
 * with baked ELK slots. Compare against a screenshot of the running app.
 */

const nodeTypes = {
  agent: AgentNode,
  userInput: EndpointNode,
  captain: EndpointNode,
};
const edgeTypes = { step: StepEdge };

const RUNNING = new Set(
  DEMO_NODES.filter((n) => n.data.status === "running").map((n) => n.id),
);

const flowNodes: Node[] = DEMO_NODES.map((n, i) => ({
  id: n.id,
  type: n.type,
  position: DEMO_LAYOUT.positions[n.id] ?? { x: 0, y: 0 },
  data: { ...n.data, handleDirection: "horizontal", enterIndex: i },
}));

const flowEdges: Edge[] = [...DEMO_LAYOUT_EDGES, ...DEMO_DEBATE_EDGES].map((e) => ({
  id: e.id,
  source: e.source,
  target: e.target,
  type: "step",
  data: { kind: e.kind, animated: RUNNING.has(e.target) },
}));

const ZOOM = Math.min(1, WIDTH / DEMO_LAYOUT.width);
const VIEWPORT = {
  x: (WIDTH - DEMO_LAYOUT.width * ZOOM) / 2,
  y: (HEIGHT - DEMO_LAYOUT.height * ZOOM) / 2,
  zoom: ZOOM,
};

export const PixelCheck: React.FC = () => {
  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        background: "var(--background)",
      }}
    >
      <TooltipProvider>
        <ReactFlowProvider>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={VIEWPORT}
            fitView={false}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
          >
            <Background gap={20} size={1} />
          </ReactFlow>
        </ReactFlowProvider>
      </TooltipProvider>
    </div>
  );
};
