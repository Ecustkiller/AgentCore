import { TOWN_GLB_URLS } from "@/simulation/town/assetPaths";
import {
  colormapUrlForGlb,
  prepareTownMesh,
  townColormapUrls,
} from "@/simulation/town/townGltfUtils";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

describe("colormapUrlForGlb", () => {
  it("resolves colormap beside buildings GLB", () => {
    expect(
      colormapUrlForGlb("/simulation/assets/buildings/building-f.glb"),
    ).toBe("/simulation/assets/buildings/Textures/colormap.png");
  });

  it("resolves colormap beside Kenney pack GLB (spaces in path)", () => {
    expect(
      colormapUrlForGlb(
        "/simulation/assets/kenney_city-kit-commercial/Models/GLB format/building-a.glb",
      ),
    ).toBe(
      "/simulation/assets/kenney_city-kit-commercial/Models/GLB format/Textures/colormap.png",
    );
  });
});

describe("townColormapUrls", () => {
  it("dedupes buildings and Kenney colormap paths", () => {
    const urls = townColormapUrls(TOWN_GLB_URLS);
    expect(urls).toHaveLength(2);
    expect(urls).toContain(
      "/simulation/assets/buildings/Textures/colormap.png",
    );
    expect(urls).toContain(
      "/simulation/assets/kenney_city-kit-commercial/Models/GLB format/Textures/colormap.png",
    );
  });
});

describe("prepareTownMesh", () => {
  it("sets per-mesh shadow flags and applies colormap fallback", () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
    );
    const root = new THREE.Group();
    root.add(mesh);

    const colormap = new THREE.Texture();
    prepareTownMesh(root, { castShadow: true, colormap });

    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(false);
    expect((mesh.material as THREE.MeshStandardMaterial).map).toBe(colormap);
    expect(colormap.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("overwrites an existing map when colormap is supplied", () => {
    const stale = new THREE.Texture();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ map: stale }),
    );
    const colormap = new THREE.Texture();
    prepareTownMesh(mesh, { colormap });
    expect((mesh.material as THREE.MeshStandardMaterial).map).toBe(colormap);
  });

  it("disables castShadow when requested", () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
    );
    prepareTownMesh(mesh, { castShadow: false });
    expect(mesh.castShadow).toBe(false);
  });
});
