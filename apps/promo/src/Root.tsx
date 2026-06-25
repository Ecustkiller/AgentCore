import "./styles.css";
import { Composition, Still } from "remotion";
import { DEMO_LAYOUT } from "./data/layout";
import { STILL_DEFS } from "./data/stills";
import { STILLS_LAYOUT } from "./data/stillsLayout";
import { ensurePromoFonts } from "./fonts";
import { PixelCheck } from "./PixelCheck";
import {
  APPSHELL_H,
  APPSHELL_W,
  AppShellStill,
} from "./scenes/AppShellStill";
import {
  MOBILE_H,
  MOBILE_W,
  MobileChatStill,
} from "./scenes/MobileChatStill";
import { LogoScene } from "./scenes/LogoScene";
import {
  CLOSEUP_H,
  CLOSEUP_W,
  NodeCloseupStill,
} from "./scenes/NodeCloseupStill";
import { PayoffStill } from "./scenes/PayoffStill";
import { stillFrameSize, stillRatio, StillScene } from "./scenes/StillScene";
import {
  OpeningStandalone,
  PROMO_FRAMES,
  RunStandalone,
  ScenarioStandalone,
  Video,
} from "./Video";

// Kick off webfont loading at module eval (registers a delayRender) so every
// composition waits for Inter + Noto Sans SC before its first frame.
ensurePromoFonts();

const FPS = 30;
const W = 1920;
const H = 1080;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Full 30s promo (the deliverable). */}
      <Composition
        id="Promo"
        component={Video}
        durationInFrames={PROMO_FRAMES}
        fps={FPS}
        width={W}
        height={H}
      />

      {/* Per-scene compositions for fast iteration in Studio. */}
      <Composition
        id="Opening"
        component={OpeningStandalone}
        durationInFrames={210}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="Run"
        component={RunStandalone}
        durationInFrames={510}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="Scenarios"
        component={ScenarioStandalone}
        durationInFrames={90}
        fps={FPS}
        width={W}
        height={H}
      />
      <Composition
        id="Logo"
        component={LogoScene}
        durationInFrames={90}
        fps={FPS}
        width={W}
        height={H}
      />

      <Still id="PixelCheck" component={PixelCheck} width={W} height={H} />

      {/* 领衔 still: full desktop shell with the hero DAG executing inside it —
          the "real product + live team" shot the bbox crops can't give. A 4:3
          desktop window (1920×1440, unified ratio), so it's registered here with
          its own dims, not from STILL_DEFS. */}
      <Still
        id="Still-appshell"
        component={AppShellStill}
        width={APPSHELL_W}
        height={APPSHELL_H}
      />

      {/* 功能特写 still: one real AgentNode at native size, showing the full chip
          vocabulary (模型档 / 深度 / 流式预览 + ▋ / 用时·工具). Sized to the card +
          margin, so it's standalone like appshell (not a STILL_DEFS bbox graph). */}
      <Still
        id="Still-nodecard"
        component={NodeCloseupStill}
        width={CLOSEUP_W}
        height={CLOSEUP_H}
      />

      {/* 收束高潮 still: the demo butterfly fully delivered with the CEO 汇聚点 lit
          and output converging in — the team's payoff beat. Sized to the demo bbox
          framed 4:3 (same as the STILL_DEFS diagrams). */}
      {(() => {
        const { width, height } = stillFrameSize(
          DEMO_LAYOUT.width,
          DEMO_LAYOUT.height,
        );
        return (
          <Still
            id="Still-payoff"
            component={PayoffStill}
            width={width}
            height={height}
          />
        );
      })()}

      <Still
        id="Still-mobile"
        component={MobileChatStill}
        width={MOBILE_W}
        height={MOBILE_H}
      />

      {/* Product-manual collaboration diagrams as standalone promo stills, each
          sized to its baked ELK bbox (+ margin). Render: `pnpm stills` → 2x PNGs. */}
      {STILL_DEFS.map((def) => {
        const lay = STILLS_LAYOUT[def.id];
        const { width, height } = stillFrameSize(
          lay.width,
          lay.height,
          stillRatio(def),
        );
        return (
          <Still
            key={def.id}
            id={`Still-${def.id}`}
            component={StillScene}
            width={width}
            height={height}
            defaultProps={{ scenarioId: def.id }}
          />
        );
      })}
    </>
  );
};
