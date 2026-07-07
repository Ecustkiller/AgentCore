import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildTownSpawnTable,
  spawnPositionForAgent,
} from "@/simulation/town/agentSpawn";
import {
  characterHeightFromBounds,
  EXPECTED_CHARACTER_HEIGHT_M,
  measureObjectBounds,
} from "@/simulation/town/townCharacterAssets";
import {
  computeLodLevel,
  LOD_FAR,
  LOD_NEAR,
  TOWN_CAMERA_POS,
} from "@/simulation/town/townLod";
import { TOWN_AGENT_HOME, TOWN_AGENT_IDS } from "@/simulation/town/townRoster";

describe("buildTownSpawnTable", () => {
  it("assigns a distinct position to every resident", () => {
    const table = buildTownSpawnTable();
    expect(Object.keys(table)).toHaveLength(TOWN_AGENT_IDS.length);
    for (const id of TOWN_AGENT_IDS) {
      expect(table[id]).toEqual(
        spawnPositionForAgent(id, TOWN_AGENT_HOME[id]),
      );
    }
  });

  it("only liu spawns at town origin (plaza)", () => {
    const table = buildTownSpawnTable();
    const atOrigin = TOWN_AGENT_IDS.filter(
      (id) => table[id].x === 0 && table[id].z === 0,
    );
    expect(atOrigin).toEqual(["liu"]);
  });

  it("separates co-located market residents", () => {
    const table = buildTownSpawnTable();
    const zhao = table.zhao;
    const wang = table.wang;
    const wu = table.wu;
    expect(zhao).not.toEqual(wang);
    expect(zhao).not.toEqual(wu);
    expect(wang).not.toEqual(wu);
  });
});

describe("computeLodLevel", () => {
  it("classifies spawn distances against default camera", () => {
    const liuLod = computeLodLevel(TOWN_CAMERA_POS, { x: 0, y: 0, z: 0 });
    expect(["near", "mid", "far"]).toContain(liuLod);

    const farPos = { x: 200, y: 0, z: 200 };
    expect(computeLodLevel(TOWN_CAMERA_POS, farPos)).toBe("far");
  });

  it("uses LOD_NEAR and LOD_FAR thresholds", () => {
    const onNear = computeLodLevel(TOWN_CAMERA_POS, {
      x: TOWN_CAMERA_POS[0] - LOD_NEAR + 1,
      y: TOWN_CAMERA_POS[1],
      z: TOWN_CAMERA_POS[2],
    });
    expect(onNear).toBe("near");

    const onMid = computeLodLevel(TOWN_CAMERA_POS, {
      x: TOWN_CAMERA_POS[0] - LOD_NEAR - 1,
      y: TOWN_CAMERA_POS[1],
      z: TOWN_CAMERA_POS[2],
    });
    expect(onMid).toBe("mid");

    const onFar = computeLodLevel(TOWN_CAMERA_POS, {
      x: TOWN_CAMERA_POS[0] - LOD_FAR - 1,
      y: TOWN_CAMERA_POS[1],
      z: TOWN_CAMERA_POS[2],
    });
    expect(onFar).toBe("far");
  });
});

describe("character bounds helpers", () => {
  it("measures object height from axis-aligned bounds", () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.3));
    mesh.position.y = 0.9;
    root.add(mesh);
    root.updateMatrixWorld(true);

    const bounds = measureObjectBounds(root);
    const height = characterHeightFromBounds(bounds);
    expect(height).toBeCloseTo(EXPECTED_CHARACTER_HEIGHT_M, 1);
  });
});
