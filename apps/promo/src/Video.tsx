import type { ReactNode } from "react";
import {
  AbsoluteFill,
  Audio,
  getInputProps,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { PromoShell } from "./chrome/PromoShell";
import { LogoScene } from "./scenes/LogoScene";
import { OpeningMain } from "./scenes/OpeningScene";
import { RunMain } from "./scenes/RunScene";
import { ScenarioMain } from "./scenes/ScenarioScene";
import { Subtitles } from "./scenes/Subtitles";

/*
 * Master 30s timeline (宣传视频落地设计.md §五). The desktop shell is the 全程基线 —
 * mounted once, behind every app scene — while the main area swaps content by
 * phase, each phase a <Sequence> so its useCurrentFrame is scene-local (entrance
 * / pulse / streaming all reset to 0 at the phase start):
 *
 *   0–210   (0–7s)   opening: empty state → typing → user bubble
 *   210–720 (7–24s)  run: cascade entrance + execution + answer (the heart)
 *   720–810 (24–27s) capability montage (3 quick cuts)
 *   810–900 (27–30s) logo end card (full-bleed, over the shell)
 *
 * Phase 4 post: adjacent phases overlap by FADE frames and cross-dissolve
 * (PhaseFade) WITHOUT shifting any phase's start — so the global-frame subtitle
 * track and the 810 logo stay perfectly aligned. A light grade (contrast +
 * saturation) and a soft vignette sit over the graded stack; the subtitle track
 * stays above the grade so it renders crisp. Drop a BGM file to fill the track.
 */

export const PROMO_FRAMES = 900; // 30s @ 30fps
const FADE = 10; // cross-dissolve length between phases

// Drop apps/promo/public/bgm.mp3 and set this to "bgm.mp3" to score the film.
// Left null so renders never fail on a missing track (BGM 用户后续自加, §七).
const BGM_FILE: string | null = null;

/** Color grade + vignette strength. Defaults = the shipped subtle look; override
 *  any field at render time via --props='{"grade":{...}}' for A/B comparison
 *  without touching code (e.g. --props='{"grade":{"contrast":1,"saturate":1,"vignette":0}}'
 *  for the ungraded product look). */
export interface Grade {
  contrast: number;
  saturate: number;
  vignette: number;
}
const DEFAULT_GRADE: Grade = { contrast: 1.03, saturate: 1.06, vignette: 0.09 };

function resolveGrade(): Grade {
  const props = getInputProps() as { grade?: Partial<Grade> };
  return { ...DEFAULT_GRADE, ...(props.grade ?? {}) };
}

/** Wraps a phase's content with frame-driven fade in/out for cross-dissolves.
 *  `len` is the phase's nominal length; its Sequence is extended by FADE so the
 *  fade-out tail renders and overlaps the next phase's fade-in. */
function PhaseFade({
  len,
  fadeIn,
  fadeOut,
  children,
}: {
  len: number;
  fadeIn?: boolean;
  fadeOut?: boolean;
  children: ReactNode;
}) {
  const frame = useCurrentFrame();
  const opIn = fadeIn
    ? interpolate(frame, [0, FADE], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  const opOut = fadeOut
    ? interpolate(frame, [len, len + FADE], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;
  return (
    <AbsoluteFill style={{ opacity: Math.min(opIn, opOut) }}>
      {children}
    </AbsoluteFill>
  );
}

/** Soft vignette — barely-there darkened corners to settle the bright frame.
 *  `alpha`=0 disables it entirely (ungraded product look). */
function Vignette({ alpha }: { alpha: number }) {
  if (alpha <= 0) return null;
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        background: `radial-gradient(ellipse 75% 75% at 50% 48%, transparent 62%, rgb(15 23 42 / ${alpha}) 100%)`,
      }}
    />
  );
}

export const Video: React.FC = () => {
  const grade = resolveGrade();
  return (
    <AbsoluteFill className="bg-background">
      {BGM_FILE && <Audio src={staticFile(BGM_FILE)} volume={0.55} />}

      {/* Graded stack: everything visual except the subtitles. */}
      <AbsoluteFill
        style={{ filter: `contrast(${grade.contrast}) saturate(${grade.saturate})` }}
      >
        <PromoShell>
          <Sequence from={0} durationInFrames={210 + FADE} name="开场 0–7s">
            <PhaseFade len={210} fadeIn fadeOut>
              <OpeningMain />
            </PhaseFade>
          </Sequence>
          <Sequence from={210} durationInFrames={510 + FADE} name="协作执行 7–24s">
            <PhaseFade len={510} fadeIn fadeOut>
              <RunMain />
            </PhaseFade>
          </Sequence>
          <Sequence from={720} durationInFrames={90 + FADE} name="能力快闪 24–27s">
            <PhaseFade len={90} fadeIn fadeOut>
              <ScenarioMain />
            </PhaseFade>
          </Sequence>
        </PromoShell>

        <Sequence from={810} durationInFrames={90} name="片尾 27–30s">
          <LogoScene />
        </Sequence>

        <Vignette alpha={grade.vignette} />
      </AbsoluteFill>

      <Subtitles />
    </AbsoluteFill>
  );
};

// ── Standalone wrappers for iterating individual scenes in Remotion Studio ────

export const RunStandalone: React.FC = () => (
  <AbsoluteFill className="bg-background">
    <PromoShell>
      <RunMain />
    </PromoShell>
  </AbsoluteFill>
);

export const OpeningStandalone: React.FC = () => (
  <AbsoluteFill className="bg-background">
    <PromoShell>
      <OpeningMain />
    </PromoShell>
  </AbsoluteFill>
);

export const ScenarioStandalone: React.FC = () => (
  <AbsoluteFill className="bg-background">
    <PromoShell>
      <ScenarioMain />
    </PromoShell>
  </AbsoluteFill>
);
