import * as THREE from "three";
import { REGION_POSITIONS } from "../regionPositions";
import { TOWN_REGIONS } from "./regionLayout";
import { TOWN_ROADS, TOWN_ZONE_GROUNDS } from "./townGround";

/** World bounds — matches nav plane 80×64 centered at origin. */
const MIN_X = -40;
const MAX_X = 40;
const MIN_Z = -32;
const MAX_Z = 32;
const CELL = 2;

const COLS = Math.ceil((MAX_X - MIN_X) / CELL);
const ROWS = Math.ceil((MAX_Z - MIN_Z) / CELL);

type GridCell = { gx: number; gz: number };

type GroundPatch = {
  position: readonly [number, number, number];
  size: readonly [number, number];
};

let obstacleGrid: boolean[][] | null = null;

function forEachCellInRect(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  fn: (gx: number, gz: number) => void,
): void {
  const g0x = Math.floor((x0 - MIN_X) / CELL);
  const g1x = Math.ceil((x1 - MIN_X) / CELL);
  const g0z = Math.floor((z0 - MIN_Z) / CELL);
  const g1z = Math.ceil((z1 - MIN_Z) / CELL);
  for (let gx = g0x; gx < g1x; gx += 1) {
    for (let gz = g0z; gz < g1z; gz += 1) {
      if (gx >= 0 && gx < COLS && gz >= 0 && gz < ROWS) {
        fn(gx, gz);
      }
    }
  }
}

function markWalkablePatch(blocked: boolean[][], patch: GroundPatch): void {
  const [x, , z] = patch.position;
  const [w, d] = patch.size;
  forEachCellInRect(x - w / 2, x + w / 2, z - d / 2, z + d / 2, (gx, gz) => {
    blocked[gx][gz] = false;
  });
}

function markBlockedRect(
  blocked: boolean[][],
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): void {
  forEachCellInRect(x0, x1, z0, z1, (gx, gz) => {
    blocked[gx][gz] = true;
  });
}

/** Roads + zone lots walkable; building footprints block on top. */
function buildObstacleGrid(): boolean[][] {
  if (obstacleGrid) return obstacleGrid;

  const blocked = Array.from({ length: COLS }, () =>
    Array.from({ length: ROWS }, () => true),
  );

  for (const patch of TOWN_ROADS) {
    markWalkablePatch(blocked, patch);
  }
  for (const patch of TOWN_ZONE_GROUNDS) {
    markWalkablePatch(blocked, patch);
  }

  for (const region of TOWN_REGIONS) {
    for (const model of region.models) {
      const [x, , z] = model.position;
      const half = 3.2 * (model.scale ?? 1);
      markBlockedRect(blocked, x - half, x + half, z - half, z + half);
    }
  }

  // Roads stay connected even when building meshes overlap the asphalt.
  for (const patch of TOWN_ROADS) {
    markWalkablePatch(blocked, patch);
  }

  // Backend / SSE authoritative anchors must remain reachable.
  for (const anchor of Object.values(REGION_POSITIONS)) {
    forEachCellInRect(
      anchor.x - CELL,
      anchor.x + CELL,
      anchor.z - CELL,
      anchor.z + CELL,
      (gx, gz) => {
        blocked[gx][gz] = false;
      },
    );
  }

  obstacleGrid = blocked;
  return blocked;
}

/** Test hook — rebuild grid after layout edits. */
export function resetTownPathGridForTests(): void {
  obstacleGrid = null;
}

/** @internal Test helper — whether a world XZ point is on a walkable cell. */
export function isTownWalkableAt(x: number, z: number): boolean {
  const grid = buildObstacleGrid();
  const cell = worldToGrid(x, z);
  if (!cell) return false;
  return isWalkable(grid, cell.gx, cell.gz);
}

function worldToGrid(x: number, z: number): GridCell | null {
  const gx = Math.floor((x - MIN_X) / CELL);
  const gz = Math.floor((z - MIN_Z) / CELL);
  if (gx < 0 || gx >= COLS || gz < 0 || gz >= ROWS) return null;
  return { gx, gz };
}

function gridToWorld(gx: number, gz: number): THREE.Vector3 {
  return new THREE.Vector3(
    MIN_X + (gx + 0.5) * CELL,
    0,
    MIN_Z + (gz + 0.5) * CELL,
  );
}

function isWalkable(grid: boolean[][], gx: number, gz: number): boolean {
  return gx >= 0 && gx < COLS && gz >= 0 && gz < ROWS && !grid[gx][gz];
}

function nearestWalkable(grid: boolean[][], cell: GridCell): GridCell | null {
  if (isWalkable(grid, cell.gx, cell.gz)) return cell;
  const queue: GridCell[] = [cell];
  const seen = new Set<string>([`${cell.gx},${cell.gz}`]);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (isWalkable(grid, cur.gx, cur.gz)) return cur;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cur.gx + dx;
      const nz = cur.gz + dz;
      const key = `${nx},${nz}`;
      if (seen.has(key)) continue;
      if (nx < 0 || nx >= COLS || nz < 0 || nz >= ROWS) continue;
      seen.add(key);
      queue.push({ gx: nx, gz: nz });
    }
  }
  return null;
}

function astar(grid: boolean[][], start: GridCell, goal: GridCell): GridCell[] {
  if (start.gx === goal.gx && start.gz === goal.gz) return [start];

  const key = (c: GridCell) => `${c.gx},${c.gz}`;
  const open = new Map<string, { cell: GridCell; f: number }>();
  const cameFrom = new Map<string, GridCell>();
  const gScore = new Map<string, number>();

  const h = (c: GridCell) =>
    Math.abs(c.gx - goal.gx) + Math.abs(c.gz - goal.gz);

  const startKey = key(start);
  gScore.set(startKey, 0);
  open.set(startKey, { cell: start, f: h(start) });

  while (open.size > 0) {
    let current: GridCell | null = null;
    let bestF = Number.POSITIVE_INFINITY;
    for (const entry of open.values()) {
      if (entry.f < bestF) {
        bestF = entry.f;
        current = entry.cell;
      }
    }
    if (!current) break;

    const currentKey = key(current);
    if (current.gx === goal.gx && current.gz === goal.gz) {
      const path: GridCell[] = [current];
      let k = currentKey;
      while (cameFrom.has(k)) {
        const prev = cameFrom.get(k);
        if (!prev) break;
        path.unshift(prev);
        k = key(prev);
      }
      return path;
    }

    open.delete(currentKey);
    const curG = gScore.get(currentKey) ?? Number.POSITIVE_INFINITY;

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = current.gx + dx;
      const nz = current.gz + dz;
      if (!isWalkable(grid, nx, nz)) continue;
      const neighbor = { gx: nx, gz: nz };
      const nKey = key(neighbor);
      const tentative = curG + 1;
      if (tentative >= (gScore.get(nKey) ?? Number.POSITIVE_INFINITY)) continue;
      cameFrom.set(nKey, current);
      gScore.set(nKey, tentative);
      open.set(nKey, { cell: neighbor, f: tentative + h(neighbor) });
    }
  }

  return [];
}

function hasLineOfSight(
  grid: boolean[][],
  from: GridCell,
  to: GridCell,
): boolean {
  let x0 = from.gx;
  let z0 = from.gz;
  const x1 = to.gx;
  const z1 = to.gz;
  const dx = Math.abs(x1 - x0);
  const dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;

  while (true) {
    if (!isWalkable(grid, x0, z0)) return false;
    if (x0 === x1 && z0 === z1) return true;
    const e2 = err * 2;
    if (e2 > -dz) {
      err -= dz;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      z0 += sz;
    }
  }
}

function simplifyPathCells(grid: boolean[][], cells: GridCell[]): GridCell[] {
  if (cells.length <= 2) return cells;

  const simplified: GridCell[] = [cells[0]];
  let anchor = 0;
  for (let i = 2; i < cells.length; i++) {
    if (!hasLineOfSight(grid, cells[anchor], cells[i])) {
      simplified.push(cells[i - 1]);
      anchor = i - 1;
    }
  }
  simplified.push(cells[cells.length - 1]);
  return simplified;
}

/**
 * Grid A* on roads + zone lots (buildings blocked).
 * Returns empty when no route — caller should not straight-line through obstacles.
 */
export function computeTownPath(
  from: THREE.Vector3,
  to: THREE.Vector3,
): THREE.Vector3[] {
  const grid = buildObstacleGrid();
  const startCell = worldToGrid(from.x, from.z);
  const goalCell = worldToGrid(to.x, to.z);
  if (!startCell || !goalCell) return [];

  const start = nearestWalkable(grid, startCell);
  const goal = nearestWalkable(grid, goalCell);
  if (!start || !goal) return [];

  const cells = astar(grid, start, goal);
  if (cells.length === 0) return [];

  const simplified = simplifyPathCells(grid, cells);
  return simplified.map((c) => gridToWorld(c.gx, c.gz));
}
