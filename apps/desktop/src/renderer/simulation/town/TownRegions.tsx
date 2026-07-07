import { Html } from "@react-three/drei";
import { useMemo } from "react";
import { TownBuilding } from "./TownBuilding";
import { TOWN_REGIONS } from "./regionLayout";
import { TOWN_ROADS, TOWN_ZONE_GROUNDS } from "./townGround";
import {
  type GroundSurfaceKind,
  getTownGroundTextureForPatch,
} from "./townTextures";

const BASE_GRASS_COLOR = "#7cb87c";
const BASE_GRASS_SIZE: readonly [number, number] = [88, 72];

function GroundPatch({
  position,
  size,
  color,
  surface,
  elevation,
}: {
  position: readonly [number, number, number];
  size: readonly [number, number];
  color: string;
  surface: GroundSurfaceKind;
  elevation?: number;
}) {
  const map = useMemo(
    () => getTownGroundTextureForPatch(surface, color, size),
    [surface, color, size],
  );

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
      position={[position[0], elevation ?? position[1], position[2]]}
    >
      <planeGeometry args={size} />
      <meshStandardMaterial map={map} roughness={0.95} />
    </mesh>
  );
}

function RegionLabel({
  label,
  position,
}: {
  label: string;
  position: readonly [number, number, number];
}) {
  return (
    <Html
      position={[position[0], 2.2, position[2]]}
      center
      distanceFactor={18}
      style={{ pointerEvents: "none" }}
    >
      <span className="rounded-lg border border-border bg-card/90 px-2 py-0.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm">
        {label}
      </span>
    </Html>
  );
}

/** Ground, roads, and seven labeled Kenney zones. */
export function TownRegions() {
  const baseGrassMap = useMemo(
    () =>
      getTownGroundTextureForPatch("grass", BASE_GRASS_COLOR, BASE_GRASS_SIZE),
    [],
  );

  return (
    <group>
      {/* Base grass */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        position={[0, -0.01, 0]}
      >
        <planeGeometry args={BASE_GRASS_SIZE} />
        <meshStandardMaterial map={baseGrassMap} roughness={0.95} />
      </mesh>

      {TOWN_ROADS.map((patch) => (
        <GroundPatch
          key={`road-${patch.position.join(",")}-${patch.size.join(",")}`}
          {...patch}
        />
      ))}
      {TOWN_ZONE_GROUNDS.map((patch) => (
        <GroundPatch
          key={`zone-${patch.position.join(",")}-${patch.size.join(",")}`}
          {...patch}
        />
      ))}

      {TOWN_REGIONS.map((region) => (
        <group key={region.id}>
          {region.models.map((model, i) => (
            <TownBuilding
              key={`${region.id}-${i}`}
              url={model.url}
              position={model.position}
              rotationY={model.rotationY}
              scale={model.scale}
              castShadow={model.castShadow}
            />
          ))}
          <RegionLabel label={region.label} position={region.center} />
        </group>
      ))}
    </group>
  );
}
