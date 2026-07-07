import * as THREE from "three";
import { Pathfinding } from "three-pathfinding";

export const TOWN_NAV_ZONE = "town-m1";

/** Walkable ground — covers backend REGION_POSITIONS span (±36 x, ±24 z). */
export function createTownNavMeshGeometry(): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(80, 64, 4, 4);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function createTownPathfinding(): Pathfinding {
  const pathfinding = new Pathfinding();
  const zone = Pathfinding.createZone(createTownNavMeshGeometry());
  pathfinding.setZoneData(TOWN_NAV_ZONE, zone);
  return pathfinding;
}

export function computeTownPath(
  pathfinding: Pathfinding,
  from: THREE.Vector3,
  to: THREE.Vector3,
): THREE.Vector3[] {
  const group = pathfinding.getGroup(TOWN_NAV_ZONE, from);
  const raw = pathfinding.findPath(from, to, TOWN_NAV_ZONE, group);
  if (!raw?.length) return [];
  return raw.map((p) => new THREE.Vector3(p.x, p.y, p.z));
}
