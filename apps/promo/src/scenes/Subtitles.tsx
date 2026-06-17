import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

/*
 * The brand-narrative subtitle track (宣传视频落地设计.md §五). Verbatim copy from
 * the storyboard — the film argues "协作，是更高级的智能" while the picture demos
 * the product. Driven by the global frame; each cue cross-fades at its edges.
 */

interface Cue {
  from: number;
  to: number;
  text: string;
}

// @30fps. The 27–30s logo card carries the slogan itself, so no cue there.
const CUES: Cue[] = [
  { from: 0, to: 90, text: "人类文明的突破，从来不靠某一个人" },
  { from: 90, to: 210, text: "而是靠分工与协作" },
  { from: 210, to: 330, text: "AI 也一样" },
  { from: 330, to: 600, text: "单个模型有天花板，协作没有" },
  { from: 600, to: 720, text: "结果，自动汇聚为一个答案" },
  { from: 720, to: 810, text: "并行 · 辩论 · 嵌套，一张图" },
];

const FADE = 8;

export function Subtitles() {
  const frame = useCurrentFrame();
  const cue = CUES.find((c) => frame >= c.from && frame < c.to);
  if (!cue) return null;

  const opacity = interpolate(
    frame,
    [cue.from, cue.from + FADE, cue.to - FADE, cue.to],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 96,
          display: "flex",
          justifyContent: "center",
          opacity,
        }}
      >
        <div
          className="rounded-2xl bg-background/70 px-7 py-3 text-3xl font-medium text-foreground"
          style={{
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            boxShadow: "0 4px 24px rgb(0 0 0 / 0.08)",
            letterSpacing: "0.01em",
          }}
        >
          {cue.text}
        </div>
      </div>
    </AbsoluteFill>
  );
}
