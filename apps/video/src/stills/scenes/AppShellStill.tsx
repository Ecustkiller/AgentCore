import { AbsoluteFill } from "remotion";
import { PromoCanvas } from "../../core/chrome/PromoCanvas";
import { PromoShell } from "../../core/chrome/PromoShell";
import { DEMO_TASK } from "../../kit/hero/demo";
import { buildHeroGraphState } from "../../kit/hero/graphSpec";
import { DEMO_LAYOUT } from "../../kit/hero/layout";
import { HERO_SHELL_RECENT } from "../../kit/hero/shellRecent";

/*
 * Full desktop shell (TitleBar + Sidebar) with the conversation canvas running
 * inside — "this is a real product" and "a real team is alive in it".
 * PromoShell + PromoCanvas embed GraphStage; frozen mid-fanout.
 */

export const APPSHELL_W = 1920;
export const APPSHELL_H = 1440;

/** Default fanout: three workers running. */
const SPINE_FROZEN = 150;
const FPS = 30;

export function AppShellStill() {
  const { nodes, edges, debate } = buildHeroGraphState(SPINE_FROZEN, FPS);
  return (
    <AbsoluteFill className="bg-background">
      <PromoShell recent={HERO_SHELL_RECENT} theme="light">
        <PromoCanvas
          taskTitle={DEMO_TASK}
          graphW={DEMO_LAYOUT.width}
          graphH={DEMO_LAYOUT.height}
          nodes={nodes}
          edges={edges}
          debate={debate}
          frame={SPINE_FROZEN}
        />
      </PromoShell>
    </AbsoluteFill>
  );
}
