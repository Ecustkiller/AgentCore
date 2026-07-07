import { useGLTF, useTexture } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import { colormapUrlForGlb, prepareTownMesh } from "./townGltfUtils";

/** One prepared mesh tree per GLB URL — instances shallow-clone to share geometry. */
const buildingPrototypeCache = new Map<string, THREE.Object3D>();

function getBuildingPrototype(
  url: string,
  scene: THREE.Object3D,
  colormap: THREE.Texture,
  castShadow: boolean,
): THREE.Object3D {
  const key = `${url}|shadow:${castShadow}`;
  let proto = buildingPrototypeCache.get(key);
  if (!proto) {
    proto = scene.clone(true);
    prepareTownMesh(proto, { castShadow, colormap });
    buildingPrototypeCache.set(key, proto);
  }
  return proto.clone(false);
}

export function TownBuilding({
  url,
  position,
  rotationY = 0,
  scale = 1,
  castShadow = true,
}: {
  url: string;
  position: readonly [number, number, number];
  rotationY?: number;
  scale?: number;
  castShadow?: boolean;
}) {
  const { scene } = useGLTF(url);
  const colormap = useTexture(colormapUrlForGlb(url));
  const instance = useMemo(
    () => getBuildingPrototype(url, scene, colormap, castShadow),
    [url, scene, colormap, castShadow],
  );

  return (
    <primitive
      object={instance}
      position={position}
      rotation={[0, rotationY, 0]}
      scale={scale}
    />
  );
}
