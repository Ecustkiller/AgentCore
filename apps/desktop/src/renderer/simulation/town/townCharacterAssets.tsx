import { useGLTF } from "@react-three/drei";
import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";
import { SIM_CHARACTER_GLB } from "./assetPaths";
import { prepareTownMesh } from "./townGltfUtils";
import { townRenderDebug } from "./townRenderDebug";

/** Mixamo Xbot GLB uses Armature.scale=0.01 — world height ≈ 1.8 m after import. */
export const EXPECTED_CHARACTER_HEIGHT_M = 1.8;
export const CHARACTER_HEIGHT_TOLERANCE_M = 0.3;

export type CharacterTemplate = {
  animations: THREE.AnimationClip[];
  bounds: THREE.Box3;
  createInstance: () => THREE.Object3D;
};

export function measureObjectBounds(root: THREE.Object3D): THREE.Box3 {
  return new THREE.Box3().setFromObject(root);
}

export function characterHeightFromBounds(bounds: THREE.Box3): number {
  return bounds.max.y - bounds.min.y;
}

function assertCharacterHeight(bounds: THREE.Box3): void {
  if (!import.meta.env.DEV) return;
  const height = characterHeightFromBounds(bounds);
  if (
    Math.abs(height - EXPECTED_CHARACTER_HEIGHT_M) >
    CHARACTER_HEIGHT_TOLERANCE_M
  ) {
    townRenderDebug.warnBounds({
      height,
      expected: EXPECTED_CHARACTER_HEIGHT_M,
      min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
      max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
    });
  }
}

function buildCharacterTemplate(
  scene: THREE.Object3D,
  animations: THREE.AnimationClip[],
): CharacterTemplate {
  prepareTownMesh(scene, { castShadow: true });
  const bounds = measureObjectBounds(scene);
  const height = characterHeightFromBounds(bounds);
  assertCharacterHeight(bounds);
  townRenderDebug.assetLoaded({
    height,
    clipCount: animations.length,
  });

  return {
    animations,
    bounds,
    createInstance: () => {
      const clone = SkeletonUtils.clone(scene);
      prepareTownMesh(clone, { castShadow: true });
      townRenderDebug.assetClone({ height });
      return clone;
    },
  };
}

const TownCharacterAssetsContext = createContext<CharacterTemplate | null>(
  null,
);

/** Loads the Mixamo GLB once; NPCs clone skinned meshes via SkeletonUtils. */
export function TownCharacterAssetsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { scene, animations } = useGLTF(SIM_CHARACTER_GLB);
  const template = useMemo(
    () => buildCharacterTemplate(scene, animations),
    [animations, scene],
  );

  return (
    <TownCharacterAssetsContext.Provider value={template}>
      {children}
    </TownCharacterAssetsContext.Provider>
  );
}

export function useTownCharacterAssets(): CharacterTemplate {
  const ctx = useContext(TownCharacterAssetsContext);
  if (!ctx) {
    throw new Error(
      "useTownCharacterAssets requires TownCharacterAssetsProvider",
    );
  }
  return ctx;
}

useGLTF.preload(SIM_CHARACTER_GLB);
