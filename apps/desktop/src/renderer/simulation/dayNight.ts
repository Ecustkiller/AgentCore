import * as THREE from "three";

export type DayNightPalette = {
  background: string;
  fog: string;
  ambientIntensity: number;
  ambientColor: string;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  sunPosition: [number, number, number];
  envIntensity: number;
};

type HourKeyframe = { hour: number } & DayNightPalette;

const KEYFRAMES: HourKeyframe[] = [
  {
    hour: 0,
    background: "#0a1228",
    fog: "#0a1228",
    ambientIntensity: 0.12,
    ambientColor: "#8a9ec8",
    hemiSky: "#1a2848",
    hemiGround: "#0a1020",
    hemiIntensity: 0.08,
    sunColor: "#6a7aaa",
    sunIntensity: 0.05,
    sunPosition: [-8, 4, -6],
    envIntensity: 0.05,
  },
  {
    hour: 5,
    background: "#3a4a6a",
    fog: "#4a5a78",
    ambientIntensity: 0.28,
    ambientColor: "#c8b8a8",
    hemiSky: "#8a9ab8",
    hemiGround: "#2a3040",
    hemiIntensity: 0.18,
    sunColor: "#ffb878",
    sunIntensity: 0.35,
    sunPosition: [6, 6, -10],
    envIntensity: 0.12,
  },
  {
    hour: 8,
    background: "#8ec4f0",
    fog: "#9ec8e8",
    ambientIntensity: 0.72,
    ambientColor: "#fff8f0",
    hemiSky: "#fff4e8",
    hemiGround: "#6a8fbf",
    hemiIntensity: 0.35,
    sunColor: "#fff6e8",
    sunIntensity: 1.35,
    sunPosition: [14, 22, 10],
    envIntensity: 0.35,
  },
  {
    hour: 12,
    background: "#9ed0f8",
    fog: "#a8d4f0",
    ambientIntensity: 0.78,
    ambientColor: "#ffffff",
    hemiSky: "#ffffff",
    hemiGround: "#7aa0c8",
    hemiIntensity: 0.38,
    sunColor: "#fffef8",
    sunIntensity: 1.5,
    sunPosition: [0, 28, 8],
    envIntensity: 0.4,
  },
  {
    hour: 17,
    background: "#e8a878",
    fog: "#d89870",
    ambientIntensity: 0.55,
    ambientColor: "#ffe8d0",
    hemiSky: "#ffd0a0",
    hemiGround: "#6a7088",
    hemiIntensity: 0.28,
    sunColor: "#ffb060",
    sunIntensity: 0.95,
    sunPosition: [-16, 10, 12],
    envIntensity: 0.22,
  },
  {
    hour: 20,
    background: "#2a3858",
    fog: "#2a3858",
    ambientIntensity: 0.22,
    ambientColor: "#a8b0c8",
    hemiSky: "#485878",
    hemiGround: "#1a2030",
    hemiIntensity: 0.12,
    sunColor: "#c08060",
    sunIntensity: 0.15,
    sunPosition: [-12, 5, 8],
    envIntensity: 0.08,
  },
];

function keyframeAt(index: number): HourKeyframe {
  const k = KEYFRAMES[index];
  if (!k) throw new Error(`dayNight: missing keyframe at index ${index}`);
  return k;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: string, b: string, t: number): string {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return `#${ca.lerp(cb, t).getHexString()}`;
}

function lerpVec3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Smooth palette for fractional hour (0–24 wraps). */
export function dayNightPaletteForHour(hour: number): DayNightPalette {
  const h = ((hour % 24) + 24) % 24;
  let from = keyframeAt(KEYFRAMES.length - 1);
  let to = keyframeAt(0);

  for (let i = 0; i < KEYFRAMES.length; i++) {
    const cur = keyframeAt(i);
    const next = keyframeAt((i + 1) % KEYFRAMES.length);
    if (h >= cur.hour && h < next.hour) {
      from = cur;
      to = next;
      break;
    }
    if (i === KEYFRAMES.length - 1 && h >= cur.hour) {
      from = cur;
      to = keyframeAt(0);
      break;
    }
  }

  const span =
    to.hour > from.hour ? to.hour - from.hour : 24 - from.hour + to.hour;
  const offset = h >= from.hour ? h - from.hour : 24 - from.hour + h;
  const t = span > 0 ? offset / span : 0;

  return {
    background: lerpColor(from.background, to.background, t),
    fog: lerpColor(from.fog, to.fog, t),
    ambientIntensity: lerp(from.ambientIntensity, to.ambientIntensity, t),
    ambientColor: lerpColor(from.ambientColor, to.ambientColor, t),
    hemiSky: lerpColor(from.hemiSky, to.hemiSky, t),
    hemiGround: lerpColor(from.hemiGround, to.hemiGround, t),
    hemiIntensity: lerp(from.hemiIntensity, to.hemiIntensity, t),
    sunColor: lerpColor(from.sunColor, to.sunColor, t),
    sunIntensity: lerp(from.sunIntensity, to.sunIntensity, t),
    sunPosition: lerpVec3(from.sunPosition, to.sunPosition, t),
    envIntensity: lerp(from.envIntensity, to.envIntensity, t),
  };
}
