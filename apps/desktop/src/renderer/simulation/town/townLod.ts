import type { Vec3 } from "@agentcore/contract-types";

export type LodLevel = "near" | "mid" | "far";

export const LOD_NEAR = 28;
export const LOD_FAR = 52;

/** Default town overview camera — matches TownCanvas PerspectiveCamera. */
export const TOWN_CAMERA_POS = [48, 40, 44] as const;

export function computeLodLevel(
  camera: readonly [number, number, number],
  position: Vec3,
): LodLevel {
  const dx = camera[0] - position.x;
  const dy = camera[1] - position.y;
  const dz = camera[2] - position.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > LOD_FAR) return "far";
  if (dist > LOD_NEAR) return "mid";
  return "near";
}
