import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { mainBox, PromoShell } from "../core/chrome/PromoShell";
import { GraphStage } from "../core/graph/GraphStage";
import { buildHeroGraphState } from "./hero/graphSpec";
import { DEMO_LAYOUT } from "./hero/layout";
import { HERO_SHELL_RECENT } from "./hero/shellRecent";

function GraphRunMain() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { width: boxWidth, height: boxHeight } = mainBox(width, height);
  const { nodes, edges, debate } = buildHeroGraphState(frame, fps);

  return (
    <GraphStage
      nodes={nodes}
      edges={edges}
      debate={debate}
      frame={frame}
      boxWidth={boxWidth}
      boxHeight={boxHeight}
      graphW={DEMO_LAYOUT.width}
      graphH={DEMO_LAYOUT.height}
    />
  );
}

/** Play the sample DAG on the product graph stage — Studio preview. */
export function GraphRun() {
  return (
    <AbsoluteFill className="bg-background">
      <PromoShell recent={HERO_SHELL_RECENT} theme="light">
        <GraphRunMain />
      </PromoShell>
    </AbsoluteFill>
  );
}
