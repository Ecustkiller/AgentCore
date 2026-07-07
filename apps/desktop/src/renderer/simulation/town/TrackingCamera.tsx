import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import {
  useSimulationNavStore,
  useSimulationPositionsStore,
  useSimulationUiStore,
} from "../store/simulationStore";

const CAMERA_HEIGHT = 5;
const CAMERA_DISTANCE = 8;
const LOOK_HEIGHT = 1.8;
const LERP_SPEED = 4;

const _npcPos = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

type TrackingCameraProps = {
  controlsRef: RefObject<OrbitControlsImpl | null>;
};

export function TrackingCamera({ controlsRef }: TrackingCameraProps) {
  const camera = useThree((s) => s.camera);
  const trackedAgentId = useSimulationUiStore((s) => s.trackedAgentId);
  const idealCamera = useMemo(() => new THREE.Object3D(), []);
  const prevTracked = useRef<string | null>(null);

  useEffect(() => {
    if (prevTracked.current && !trackedAgentId) {
      const controls = controlsRef.current;
      if (controls) {
        const pose =
          useSimulationPositionsStore.getState().poses[prevTracked.current];
        if (pose) {
          controls.target.set(pose.x, pose.y + LOOK_HEIGHT, pose.z);
        }
        controls.update();
      }
    }
    prevTracked.current = trackedAgentId;
  }, [trackedAgentId, controlsRef]);

  useFrame((_, delta) => {
    if (!trackedAgentId) return;

    const pose = useSimulationPositionsStore.getState().poses[trackedAgentId];
    const navTarget = useSimulationNavStore.getState().targets[trackedAgentId];
    const yaw = pose?.yaw ?? 0;

    if (pose) {
      _npcPos.set(pose.x, pose.y, pose.z);
    } else if (navTarget) {
      _npcPos.set(navTarget.x, navTarget.y, navTarget.z);
    } else {
      return;
    }

    _offset.set(0, CAMERA_HEIGHT, -CAMERA_DISTANCE);
    _offset.applyAxisAngle(_yAxis, yaw);
    _targetPos.copy(_npcPos).add(_offset);
    _lookAt.set(_npcPos.x, _npcPos.y + LOOK_HEIGHT, _npcPos.z);

    idealCamera.position.copy(_targetPos);
    idealCamera.lookAt(_lookAt);

    const t = 1 - Math.exp(-LERP_SPEED * delta);
    camera.position.lerp(idealCamera.position, t);
    camera.quaternion.slerp(idealCamera.quaternion, t);

    const controls = controlsRef.current;
    if (controls) {
      controls.target.lerp(_lookAt, t);
      controls.update();
    }
  });

  return null;
}
