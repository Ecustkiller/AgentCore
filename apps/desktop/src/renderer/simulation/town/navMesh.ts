import type * as THREE from "three";
import { computeTownPath as computeGridPath } from "./townPathGrid";

/** @deprecated Kept for TownCanvas memo signature — pathing uses townPathGrid. */
export type TownPathfinding = { __brand: "town-path-grid" };

export function createTownPathfinding(): TownPathfinding {
  return { __brand: "town-path-grid" };
}

export function computeTownPath(
  _pathfinding: TownPathfinding,
  from: THREE.Vector3,
  to: THREE.Vector3,
): THREE.Vector3[] {
  return computeGridPath(from, to);
}
