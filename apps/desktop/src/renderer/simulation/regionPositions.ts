import type { Vec3 } from "@agentcore/contract-types";
import contract from "@agentcore/protocol-conformance/fixtures/simulation-region-positions.json";

/** Authoritative town region anchors — must match backend REGION_POSITIONS. */
export const REGION_POSITIONS: Record<string, Vec3> = contract.regions;

export type TownLocationId = keyof typeof contract.regions;

export const TOWN_LOCATION_IDS = Object.keys(
  REGION_POSITIONS,
) as TownLocationId[];

export function positionForLocation(location: string): Vec3 {
  return REGION_POSITIONS[location] ?? { x: 0, y: 0, z: 0 };
}

export function locationCenter(location: string): [number, number, number] {
  const p = positionForLocation(location);
  return [p.x, p.y, p.z];
}
