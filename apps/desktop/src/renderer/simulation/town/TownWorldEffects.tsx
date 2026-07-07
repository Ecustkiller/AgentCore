import { REGION_POSITIONS } from "@/simulation/regionPositions";
import { useSimulationView } from "@/simulation/viewState";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type * as THREE from "three";

const RAIN_COUNT = 480;
const RAIN_SPREAD_X = 72;
const RAIN_SPREAD_Z = 56;
const RAIN_HEIGHT = 28;

function TownRain({ active }: { active: boolean }) {
  const pointsRef = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const arr = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      arr[i * 3] = (Math.random() - 0.5) * RAIN_SPREAD_X;
      arr[i * 3 + 1] = Math.random() * RAIN_HEIGHT;
      arr[i * 3 + 2] = (Math.random() - 0.5) * RAIN_SPREAD_Z;
    }
    return arr;
  }, []);

  useFrame((_, delta) => {
    const points = pointsRef.current;
    if (!active || !points) return;
    const attr = points.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    for (let i = 0; i < RAIN_COUNT; i++) {
      let y = attr.getY(i) - delta * 22;
      if (y < 0) {
        y = RAIN_HEIGHT + Math.random() * 6;
        attr.setX(i, (Math.random() - 0.5) * RAIN_SPREAD_X);
        attr.setZ(i, (Math.random() - 0.5) * RAIN_SPREAD_Z);
      }
      attr.setY(i, y);
    }
    attr.needsUpdate = true;
  });

  if (!active) return null;

  return (
    <points ref={pointsRef} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.1}
        color="#b8d4f0"
        transparent
        opacity={0.55}
        depthWrite={false}
      />
    </points>
  );
}

function TownFestivalGlow({ active }: { active: boolean }) {
  const plaza = REGION_POSITIONS.广场;
  if (!active) return null;

  return (
    <group position={[plaza.x, plaza.y, plaza.z]}>
      <pointLight
        color="#ffd090"
        intensity={1.4}
        distance={36}
        decay={2}
        position={[0, 6, 0]}
      />
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[4.5, 6.2, 48]} />
        <meshBasicMaterial color="#ffc870" transparent opacity={0.22} />
      </mesh>
    </group>
  );
}

/** Storm rain + festival plaza glow driven by world modifiers. */
export function TownWorldEffects() {
  const { viewModifiers } = useSimulationView();

  return (
    <>
      <TownRain active={viewModifiers.storm_active} />
      <TownFestivalGlow active={viewModifiers.festival_active} />
    </>
  );
}
