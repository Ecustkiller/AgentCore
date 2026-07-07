import type { Vec3 } from "@agentcore/contract-types";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { TownPathfinding } from "./navMesh";
import {
  type SimVec3Target,
  isReplayActive,
  useSimulationNavStore,
  useSimulationPositionsStore,
  useSimulationUiStore,
} from "../store/simulationStore";
import { NpcAvatar } from "./NpcAvatar";
import { targetsEqual } from "./agentSpawn";
import { computeTownPath } from "./navMesh";
import { useTownCharacterAssets } from "./townCharacterAssets";
import { LOD_FAR, LOD_NEAR, type LodLevel } from "./townLod";
import { townRenderDebug } from "./townRenderDebug";
import type { TownAgentId } from "./townRoster";

const WALK_SPEED = 2.2;
const ARRIVE_EPS = 0.12;

/** Default resident for tests — matches backend LIN_PERSONA.agent_id. */
export const M1_DEFAULT_AGENT_ID: TownAgentId = "lin";

export function TownNpc({
  pathfinding,
  agentId = M1_DEFAULT_AGENT_ID,
  spawnPosition,
  initialLod,
}: {
  pathfinding: TownPathfinding;
  agentId?: TownAgentId;
  spawnPosition: Vec3;
  initialLod: LodLevel;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const pathIndex = useRef(0);
  const activePath = useRef<THREE.Vector3[]>([]);
  const lastTarget = useRef<SimVec3Target | null>(null);
  const lodRef = useRef<LodLevel>(initialLod);
  const [lod, setLod] = useState<LodLevel>(initialLod);
  const [walking, setWalking] = useState(false);

  const template = useTownCharacterAssets();
  const camera = useThree((s) => s.camera);
  const selectedAgentId = useSimulationUiStore((s) => s.selectedAgentId);
  const startTracking = useSimulationUiStore((s) => s.startTracking);
  const isSelected = selectedAgentId === agentId;

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const pose = useSimulationPositionsStore.getState().poses[agentId];
    const target = useSimulationNavStore.getState().targets[agentId];
    const pos = pose ?? target ?? spawnPosition;
    group.position.set(pos.x, pos.y, pos.z);
    if (pose?.yaw != null) {
      group.rotation.y = pose.yaw;
    }
    lastTarget.current = target ? { ...target } : null;
    activePath.current = [];
    pathIndex.current = 0;
  }, [agentId, spawnPosition.x, spawnPosition.y, spawnPosition.z]);

  const applyLod = (next: LodLevel) => {
    if (lodRef.current === next) return;
    lodRef.current = next;
    setLod(next);
    townRenderDebug.lodChange({ agentId, lod: next });
  };

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;

    const dist = camera.position.distanceTo(group.position);
    applyLod(dist > LOD_FAR ? "far" : dist > LOD_NEAR ? "mid" : "near");

    const isFar = lodRef.current === "far";

    const target = useSimulationNavStore.getState().targets[agentId];
    if (!target) return;

    const replayActive = isReplayActive();

    if (!targetsEqual(lastTarget.current ?? undefined, target)) {
      lastTarget.current = { ...target };
      activePath.current = [];
      pathIndex.current = 0;
    }

    const targetVec = new THREE.Vector3(target.x, target.y, target.z);

    if (replayActive) {
      group.position.set(target.x, target.y, target.z);
      activePath.current = [];
      pathIndex.current = 0;
      if (!isFar) setWalking(false);
      useSimulationPositionsStore.getState().setPose(agentId, {
        x: group.position.x,
        y: group.position.y,
        z: group.position.z,
        yaw: group.rotation.y,
      });
      return;
    }

    const distToTarget = group.position.distanceTo(targetVec);

    if (activePath.current.length === 0 && distToTarget > ARRIVE_EPS) {
      activePath.current = computeTownPath(
        pathfinding,
        group.position.clone(),
        targetVec,
      );
      pathIndex.current = 0;
    }

    let moving = false;
    const path = activePath.current;
    if (path.length > 0) {
      let idx = pathIndex.current;
      let waypoint = path[idx];
      if (waypoint) {
        const toWp = new THREE.Vector3().subVectors(waypoint, group.position);
        toWp.y = 0;
        const distWp = toWp.length();
        if (distWp < ARRIVE_EPS) {
          idx += 1;
          if (idx >= path.length) {
            activePath.current = [];
            pathIndex.current = 0;
          } else {
            pathIndex.current = idx;
            waypoint = path[idx];
            if (waypoint) {
              toWp.subVectors(waypoint, group.position);
              toWp.y = 0;
            }
          }
        }
        if (waypoint && toWp.lengthSq() > ARRIVE_EPS * ARRIVE_EPS) {
          moving = true;
          const step = Math.min(WALK_SPEED * delta, toWp.length());
          toWp.normalize();
          group.position.addScaledVector(toWp, step);
          group.rotation.y = Math.atan2(toWp.x, toWp.z);
        }
      }
    } else if (distToTarget <= ARRIVE_EPS) {
      group.position.y = target.y;
    }

    if (!isFar) {
      setWalking(moving);
    }

    useSimulationPositionsStore.getState().setPose(agentId, {
      x: group.position.x,
      y: group.position.y,
      z: group.position.z,
      yaw: group.rotation.y,
    });
  });

  return (
    <group
      ref={groupRef}
      position={[spawnPosition.x, spawnPosition.y, spawnPosition.z]}
      onClick={(event) => {
        event.stopPropagation();
        startTracking(agentId);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "";
      }}
    >
      {isSelected ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
          <ringGeometry args={[0.55, 0.72, 32]} />
          <meshBasicMaterial color="#f0c060" transparent opacity={0.85} />
        </mesh>
      ) : null}
      <NpcAvatar
        template={template}
        agentId={agentId}
        lod={lod}
        walking={walking}
        animEnabled={lod === "near"}
      />
    </group>
  );
}