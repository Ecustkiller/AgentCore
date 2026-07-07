import { describe, expect, it } from "vitest";
import { TOWN_ROADS, TOWN_ZONE_GROUNDS } from "@/simulation/town/townGround";
import { TOWN_REGIONS, TOWN_VIEW_CENTER } from "@/simulation/town/regionLayout";
import { REGION_POSITIONS, TOWN_LOCATION_IDS } from "@/simulation/regionPositions";
import { KENNEY_BUILDINGS, TOWN_GLB_URLS } from "@/simulation/town/assetPaths";
import { TOWN_AGENT_HOME, TOWN_AGENT_IDS } from "@/simulation/town/townRoster";
import { buildTownSpawnTable } from "@/simulation/town/agentSpawn";

const BASE_GRASS_Y = -0.01;

const FOG_NEAR = 100;
const FOG_FAR = 220;
const CAMERA_POS = [48, 40, 44] as const;

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

describe("ground elevation ordering", () => {
  it("roads are above base grass", () => {
    for (const road of TOWN_ROADS) {
      expect(road.position[1]).toBeGreaterThan(BASE_GRASS_Y);
    }
  });

  it("zone grounds are above roads", () => {
    const maxRoadY = Math.max(...TOWN_ROADS.map((r) => r.position[1]));
    for (const zone of TOWN_ZONE_GROUNDS) {
      expect(zone.position[1]).toBeGreaterThanOrEqual(maxRoadY);
    }
  });

  it("no two ground layers share exact Y (z-fighting guard)", () => {
    const yValues = [
      BASE_GRASS_Y,
      ...TOWN_ROADS.map((r) => r.position[1]),
      ...TOWN_ZONE_GROUNDS.map((z) => z.position[1]),
    ];
    const rounded = yValues.map((v) => Math.round(v * 10000));
    const grassRounded = Math.round(BASE_GRASS_Y * 10000);
    for (const y of rounded) {
      if (y === grassRounded) continue;
      const others = rounded.filter(
        (o) => o !== y && o !== grassRounded && Math.abs(o - y) < 1,
      );
      expect(
        others.length,
        `Y=${y / 10000} too close to another non-grass layer`,
      ).toBe(0);
    }
  });
});

describe("fog visibility", () => {
  it("all region centers are visible (distance < fog far)", () => {
    for (const id of TOWN_LOCATION_IDS) {
      const pos = REGION_POSITIONS[id];
      const d = dist(CAMERA_POS, [pos.x, pos.y, pos.z]);
      expect(d).toBeLessThan(FOG_FAR);
    }
  });

  it("nearest regions are not fogged (distance < fog near)", () => {
    const distances = TOWN_LOCATION_IDS.map((id) => {
      const pos = REGION_POSITIONS[id];
      return dist(CAMERA_POS, [pos.x, pos.y, pos.z]);
    });
    const minDist = Math.min(...distances);
    expect(minDist).toBeLessThan(FOG_NEAR);
  });

  it("town view center is well within fog-free zone", () => {
    const d = dist(CAMERA_POS, TOWN_VIEW_CENTER);
    expect(d).toBeLessThan(FOG_NEAR);
  });
});

describe("region layout integrity", () => {
  it("every region definition maps to a valid backend position", () => {
    for (const region of TOWN_REGIONS) {
      expect(REGION_POSITIONS[region.id]).toBeDefined();
      const expected = REGION_POSITIONS[region.id];
      expect(region.center).toEqual([expected.x, expected.y, expected.z]);
    }
  });

  it("all seven zones are defined", () => {
    const ids = TOWN_REGIONS.map((r) => r.id);
    expect(ids).toContain("广场");
    expect(ids).toContain("市场");
    expect(ids).toContain("餐厅");
    expect(ids).toContain("面包店");
    expect(ids).toContain("住宅区");
    expect(ids).toContain("镇政厅");
    expect(ids).toContain("公园");
  });

  it("every region has at least one model", () => {
    for (const region of TOWN_REGIONS) {
      expect(region.models.length).toBeGreaterThan(0);
    }
  });

  it("all model URLs are from KENNEY_BUILDINGS", () => {
    const validUrls = new Set<string>(TOWN_GLB_URLS);
    for (const region of TOWN_REGIONS) {
      for (const model of region.models) {
        expect(validUrls.has(model.url)).toBe(true);
      }
    }
  });
});

describe("agent spawn consistency", () => {
  it("every town agent has a valid home location", () => {
    for (const id of TOWN_AGENT_IDS) {
      const home = TOWN_AGENT_HOME[id];
      expect(REGION_POSITIONS[home]).toBeDefined();
    }
  });

  it("agent home locations match defined regions", () => {
    const regionIds = new Set(TOWN_REGIONS.map((r) => r.id));
    for (const id of TOWN_AGENT_IDS) {
      expect(regionIds.has(TOWN_AGENT_HOME[id] as any)).toBe(true);
    }
  });

  it("has ten residents for M2 rendering", () => {
    expect(TOWN_AGENT_IDS).toHaveLength(10);
  });

  it("spawn table keeps only liu at plaza origin", () => {
    const table = buildTownSpawnTable();
    const atOrigin = TOWN_AGENT_IDS.filter(
      (id) => table[id].x === 0 && table[id].z === 0,
    );
    expect(atOrigin).toEqual(["liu"]);
  });
});

describe("coordinate bounds", () => {
  const TOWN_HALF_W = 44;
  const TOWN_HALF_D = 36;

  it("all region centers within town bounds", () => {
    for (const id of TOWN_LOCATION_IDS) {
      const pos = REGION_POSITIONS[id];
      expect(Math.abs(pos.x)).toBeLessThanOrEqual(TOWN_HALF_W);
      expect(Math.abs(pos.z)).toBeLessThanOrEqual(TOWN_HALF_D);
    }
  });

  it("all building models within town bounds", () => {
    for (const region of TOWN_REGIONS) {
      for (const model of region.models) {
        expect(
          Math.abs(model.position[0]),
          `${region.id} model X out of bounds`,
        ).toBeLessThanOrEqual(TOWN_HALF_W);
        expect(
          Math.abs(model.position[2]),
          `${region.id} model Z out of bounds`,
        ).toBeLessThanOrEqual(TOWN_HALF_D);
      }
    }
  });

  it("road patches within town bounds", () => {
    for (const road of TOWN_ROADS) {
      expect(Math.abs(road.position[0]) + road.size[0] / 2).toBeLessThanOrEqual(
        TOWN_HALF_W + 2,
      );
      expect(Math.abs(road.position[2]) + road.size[1] / 2).toBeLessThanOrEqual(
        TOWN_HALF_D + 2,
      );
    }
  });
});
