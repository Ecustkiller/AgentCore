import type { Edge, Node } from "@xyflow/react";
import { GraphStage } from "../../core/graph/GraphStage";
import { CAPTAIN_ID } from "../../kit/hero/demo";
import { buildHeroGraphState } from "../../kit/hero/graphSpec";
import { DEMO_LAYOUT } from "../../kit/hero/layout";
import { AmbientGlow, AmbientVignette, stillFrameSize, STILL_FRAME_PAD } from "./StillScene";

/*
 * Payoff still: three workers settled, CEO assembling. Captain override lights
 * the sink; inbound edges forced to flow so particles converge.
 */

const FROZEN = 240; // past last worker done (210): CEO assembling
const FPS = 30;

export function PayoffStill() {
  const { nodes, edges } = buildHeroGraphState(FROZEN, FPS, {
    captain: {
      status: "running",
      preview: "正在汇总三路调研，写成决策简报……",
      terminalFrame: null,
    },
  });

  const settled: Node[] = nodes.map((n) => ({
    ...n,
    data: { ...n.data, _enterFrame: -100, _terminalFrame: null, _glow: true },
  }));

  // Converging particles: the demo's edgeFlow has no schedule entry for the sink,
  // so force the captain's inbound edges to flow at the payoff beat.
  const converged: Edge[] = edges.map((e) =>
    e.target === CAPTAIN_ID
      ? { ...e, data: { ...(e.data as Record<string, unknown>), flow: 1, enterOpacity: 1 } }
      : e,
  );

  const { width: boxWidth, height: boxHeight } = stillFrameSize(
    DEMO_LAYOUT.width,
    DEMO_LAYOUT.height,
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <AmbientGlow />
      <GraphStage
        nodes={settled}
        edges={converged}
        debate={null}
        frame={FROZEN}
        boxWidth={boxWidth}
        boxHeight={boxHeight}
        graphW={DEMO_LAYOUT.width}
        graphH={DEMO_LAYOUT.height}
        padX={STILL_FRAME_PAD}
        padY={STILL_FRAME_PAD}
        showBackground
      />
      <AmbientVignette />
    </div>
  );
}
