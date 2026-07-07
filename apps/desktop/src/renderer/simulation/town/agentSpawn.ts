import type { Vec3 } from "@agentcore/contract-types";
import { positionForLocation } from "../regionPositions";
import {
  useSimulationNavStore,
  useSimulationPositionsStore,
} from "../store/simulationStore";
import type { TownAgentId } from "./townRoster";
import { TOWN_AGENT_HOME, TOWN_AGENT_IDS, TOWN_SPAWN_OFFSET } from "./townRoster";
import { townRenderDebug } from "./townRenderDebug";

export type TownSpawnTable = Record<TownAgentId, Vec3>;

/** Visual spawn point on the ground (region anchor + per-agent nudge). */
export function spawnPositionForAgent(
  agentId: TownAgentId,
  homeLocation: string,
): Vec3 {
  const base = positionForLocation(homeLocation);
  const offset = TOWN_SPAWN_OFFSET[agentId];
  return {
    x: base.x + offset.x,
    y: base.y,
    z: base.z + offset.z,
  };
}

/** Synchronous spawn positions for all residents — safe before first NPC render. */
export function buildTownSpawnTable(): TownSpawnTable {
  const table = {} as TownSpawnTable;
  for (const id of TOWN_AGENT_IDS) {
    table[id] = spawnPositionForAgent(id, TOWN_AGENT_HOME[id]);
  }
  townRenderDebug.spawnInit({
    agentCount: TOWN_AGENT_IDS.length,
    positions: table,
  });
  return table;
}

/** Seed nav targets + poses at home when SSE has not set them yet. */
export function seedTownSpawnsIfNeeded(_spawnTable: TownSpawnTable): void {
  for (const id of TOWN_AGENT_IDS) {
    seedAgentSpawnIfNeeded(id, TOWN_AGENT_HOME[id]);
  }
}

/**
 * Seed pose + nav target at home on first mount.
 * Skips nav target when SSE already set an authoritative destination (late GLTF mount).
 */
export function seedAgentSpawnIfNeeded(
  agentId: TownAgentId,
  homeLocation: string,
): Vec3 {
  const start = spawnPositionForAgent(agentId, homeLocation);
  const nav = useSimulationNavStore.getState();
  if (!nav.targets[agentId]) {
    useSimulationPositionsStore.getState().setPose(agentId, {
      ...start,
      yaw: 0,
    });
    nav.setTarget(agentId, start);
  }
  return start;
}

export function targetsEqual(
  a: Vec3 | undefined,
  b: Vec3 | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
