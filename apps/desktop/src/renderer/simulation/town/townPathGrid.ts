import * as THREE from "three";
import { TOWN_REGIONS } from "./regionLayout";

/** World bounds — matches nav plane 80×64 centered at origin. */
const MIN_X = -40;
const MAX_X = 40;
const MIN_Z = -32;
const MAX_Z = 32;
const CELL = 2;

const COLS = Math.ceil((MAX_X - MIN_X) / CELL);
const ROWS = Math.ceil((MAX_Z - MIN_Z) / CELL);

type GridCell = { gx: number; gz: number };

let obstacleGrid: boolean[][] | null = null;

function buildObstacleGrid(): boolean[][] {
  if (obstacleGrid) return obstacleGrid;

  const blocked = Array.from({ length: COLS }, () =>
    Array.from({ length: ROWS }, () => false),
  );

  const markRect = (x0: number, x1: number, z0: number, z1: number) => {
    const g0x = Math.floor((x0 - MIN_X) / CELL);
    const g1x = Math.ceil((x1 - MIN_X) / CELL);
    const g0z = Math.floor((z0 - MIN_Z) / CELL);
    const g1z = Math.ceil((z1 - MIN_Z) / CELL);
    for (let gx = g0x; gx < g1x; gx += 1) {
      for (let gz = g0z; gz < g1z; gz += 1) {
        if (gx >= 0 && gx < COLS && gz >= 0 && gz < ROWS) {
          blocked[gx][gz] = true;
        }
      }
    }
  };

  for (const region of TOWN_REGIONS) {
    for (const model of region.models) {
      const [x, , z] = model.position;
      const half = 3.2 * (model.scale ?? 1);
      markRect(x - half, x + half, z - half, z + half);
    }
  }

  obstacleGrid = blocked;
  return blocked;
}

/** Test hook — rebuild grid after layout edits. */
export function resetTownPathGridForTests(): void {
  obstacleGrid = null;
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

function nearestWalkable(
  grid: boolean[][],
  cell: GridCell,
): GridCell | null {
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

function astar(
  grid: boolean[][],
  start: GridCell,
  goal: GridCell,
): GridCell[] {
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
        const prev = cameFrom.get(k)!;
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

/**
 * Grid A* path that avoids building footprints from region layout.
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

  return cells.map((c) => gridToWorld(c.gx, c.gz));
}
