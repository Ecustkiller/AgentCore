import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Background,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { DEMO_LAYOUT } from "../data/layout";
import type { DebateState } from "./graphState";
import { PromoFlowEdge } from "./PromoFlowEdge";
import { PromoAgentNode, PromoEndpointNode } from "./PromoNodes";

/*
 * Reusable, deterministic renderer for the demo collaboration graph. Takes a
 * fully-derived per-frame {nodes, edges, debate} (built by graphState) and lays
 * it out centered inside the given box, scaled to fit. Used full-bleed by the
 * standalone GraphScene composition and inside the desktop shell's main area by
 * the assembled promo — same pixels either way.
 */

const nodeTypes = {
  agent: PromoAgentNode,
  userInput: PromoEndpointNode,
  captain: PromoEndpointNode,
};
const edgeTypes = { flow: PromoFlowEdge };

interface Props {
  nodes: Node[];
  edges: Edge[];
  debate: DebateState | null;
  frame: number;
  boxWidth: number;
  boxHeight: number;
  /** Graph bbox to fit (defaults to the demo butterfly's baked ELK bbox). */
  graphW?: number;
  graphH?: number;
  /** Horizontal / vertical breathing room kept around the graph bbox. */
  padX?: number;
  padY?: number;
  showBackground?: boolean;
}

export function GraphStage({
  nodes,
  edges,
  debate,
  frame,
  boxWidth,
  boxHeight,
  graphW = DEMO_LAYOUT.width,
  graphH = DEMO_LAYOUT.height,
  padX = 140,
  padY = 180,
  showBackground = true,
}: Props) {
  const W = graphW;
  const H = graphH;
  const zoom = Math.min(1, (boxWidth - padX) / W, (boxHeight - padY) / H);
  const scaledW = W * zoom;
  const scaledH = H * zoom;
  const left = (boxWidth - scaledW) / 2;
  const top = (boxHeight - scaledH) / 2;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: W,
          height: H,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}
      >
        <TooltipProvider>
          {debate && <DebateConnector debate={debate} frame={frame} />}
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              fitView={false}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              style={{ width: W, height: H, background: "transparent" }}
            >
              {showBackground && <Background gap={20} size={1} />}
            </ReactFlow>
          </ReactFlowProvider>
        </TooltipProvider>
      </div>
    </div>
  );
}

/**
 * The 辩论对射 connector: a dotted line between the debate pair with particles
 * fired both ways. Drawn in graph coords (shared with ReactFlow), behind the
 * opaque cards so particles read as emerging from one card into the other.
 */
function DebateConnector({
  debate,
  frame,
}: {
  debate: DebateState;
  frame: number;
}) {
  if (!debate.active) return null;
  const { cx, y1, y2 } = debate;
  const span = y2 - y1;

  // Two streams crossing in opposite directions (对射), looping every ~36 frames.
  const period = 36;
  const phase = (frame % period) / period;
  const down = [phase, (phase + 0.5) % 1];
  const up = [(1 - phase) % 1, (1 - phase + 0.5) % 1];
  const dots = [
    ...down.map((f) => ({ f, key: `d${f}` })),
    ...up.map((f) => ({ f, key: `u${f}` })),
  ];

  return (
    <svg
      width={DEMO_LAYOUT.width}
      height={DEMO_LAYOUT.height}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
      role="presentation"
    >
      <line
        x1={cx}
        y1={y1}
        x2={cx}
        y2={y2}
        stroke="var(--primary)"
        strokeWidth={2}
        strokeDasharray="2 4"
        opacity={0.55}
      />
      {dots.map((d) => {
        const y = y1 + d.f * span;
        const edge = Math.min(d.f, 1 - d.f);
        const opacity = Math.min(1, edge / 0.12);
        return (
          <circle
            key={d.key}
            cx={cx}
            cy={y}
            r={3}
            fill="var(--primary)"
            opacity={opacity}
          />
        );
      })}
    </svg>
  );
}
