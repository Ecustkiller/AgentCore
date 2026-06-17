import "./styles.css";
import { Composition, Still } from "remotion";
import { ensurePromoFonts } from "./fonts";
import { PixelCheck } from "./PixelCheck";
import { LogoScene } from "./scenes/LogoScene";
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
    </>
  );
};
