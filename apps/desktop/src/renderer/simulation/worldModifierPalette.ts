import type { WorldModifiersWire } from "@agentcore/contract-types";
import * as THREE from "three";
import type { DayNightPalette } from "./dayNight";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: string, b: string, t: number): string {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return `#${ca.lerp(cb, t).getHexString()}`;
}

/** Blend world modifiers into the base day/night palette for 3D lighting. */
export function applyWorldModifierPalette(
  base: DayNightPalette,
  modifiers: WorldModifiersWire,
): DayNightPalette {
  let next = { ...base };

  if (modifiers.storm_active) {
    next = {
      ...next,
      background: lerpColor(next.background, "#1a2840", 0.55),
      fog: lerpColor(next.fog, "#2a3850", 0.65),
      ambientIntensity: lerp(next.ambientIntensity, 0.18, 0.6),
      ambientColor: lerpColor(next.ambientColor, "#8a9ab8", 0.5),
      hemiSky: lerpColor(next.hemiSky, "#4a5878", 0.55),
      hemiGround: lerpColor(next.hemiGround, "#1a2030", 0.45),
      hemiIntensity: lerp(next.hemiIntensity, 0.1, 0.5),
      sunColor: lerpColor(next.sunColor, "#9aa8c0", 0.65),
      sunIntensity: lerp(next.sunIntensity, 0.12, 0.7),
      envIntensity: lerp(next.envIntensity, 0.06, 0.65),
    };
  }

  if (modifiers.festival_active) {
    next = {
      ...next,
      background: lerpColor(next.background, "#f0c898", 0.18),
      fog: lerpColor(next.fog, "#e8c0a0", 0.12),
      ambientColor: lerpColor(next.ambientColor, "#fff0d8", 0.22),
      hemiSky: lerpColor(next.hemiSky, "#ffe8c8", 0.2),
      sunColor: lerpColor(next.sunColor, "#ffe0a8", 0.15),
      sunIntensity: lerp(next.sunIntensity, next.sunIntensity + 0.15, 0.25),
      envIntensity: lerp(next.envIntensity, next.envIntensity + 0.08, 0.2),
    };
  }

  return next;
}
