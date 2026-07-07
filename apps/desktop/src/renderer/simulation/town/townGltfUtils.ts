import * as THREE from "three";

/** Kenney GLBs reference `Textures/colormap.png` beside the model file. */
export function colormapUrlForGlb(glbUrl: string): string {
  const slash = glbUrl.lastIndexOf("/");
  return `${glbUrl.slice(0, slash + 1)}Textures/colormap.png`;
}

/** Unique colormap URLs for every town GLB (buildings/ + Kenney pack paths). */
export function townColormapUrls(glbUrls: readonly string[]): string[] {
  return [...new Set(glbUrls.map(colormapUrlForGlb))];
}

type PrepareTownMeshOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Fallback when GLB external texture failed to resolve. */
  colormap?: THREE.Texture | null;
};

/**
 * Kenney GLBs use external `Textures/colormap.png`. When the relative URI fails
 * to resolve, materials stay default gray-white. Re-apply colormap + sRGB and
 * set shadow flags on each mesh (primitive-level castShadow is ignored).
 */
export function prepareTownMesh(
  root: THREE.Object3D,
  {
    castShadow = true,
    receiveShadow = false,
    colormap,
  }: PrepareTownMeshOptions,
) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    child.castShadow = castShadow;
    child.receiveShadow = receiveShadow;

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;

      if (colormap) {
        material.map = colormap;
        material.map.flipY = false;
        material.map.colorSpace = THREE.SRGBColorSpace;
      } else if (material.map) {
        material.map.colorSpace = THREE.SRGBColorSpace;
      }

      material.needsUpdate = true;
    }
  });
}
