import { REGION_POSITIONS } from "@/simulation/regionPositions";
import {
  computeTownPath,
  isTownWalkableAt,
  resetTownPathGridForTests,
} from "@/simulation/town/townPathGrid";
import * as THREE from "three";
import { beforeEach, describe, expect, it } from "vitest";

describe("computeTownPath grid", () => {
  beforeEach(() => {
    resetTownPathGridForTests();
  });

  it("finds a non-empty route between region anchors", () => {
    const plaza = REGION_POSITIONS.广场;
    const market = REGION_POSITIONS.市场;
    const path = computeTownPath(
      new THREE.Vector3(plaza.x, plaza.y, plaza.z),
      new THREE.Vector3(market.x, market.y, market.z),
    );
    expect(path.length).toBeGreaterThan(0);
  });

  it("shortens paths along clear road corridors", () => {
    const plaza = REGION_POSITIONS.广场;
    const market = REGION_POSITIONS.市场;
    const path = computeTownPath(
      new THREE.Vector3(plaza.x, plaza.y, plaza.z),
      new THREE.Vector3(market.x, market.y, market.z),
    );
    expect(path.length).toBeGreaterThan(0);
    expect(path.length).toBeLessThanOrEqual(2);
  });

  it("still detours when line-of-sight is blocked", () => {
    const market = REGION_POSITIONS.市场;
    const restaurant = REGION_POSITIONS.餐厅;
    const path = computeTownPath(
      new THREE.Vector3(market.x, market.y, market.z),
      new THREE.Vector3(restaurant.x, restaurant.y, restaurant.z),
    );
    expect(path.length).toBeGreaterThan(2);
  });

  it("returns empty when goal is unreachable outside bounds", () => {
    const path = computeTownPath(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(999, 0, 999),
    );
    expect(path).toEqual([]);
  });

  it("only allows roads and zone lots — open grass is not walkable", () => {
    expect(isTownWalkableAt(0, 0)).toBe(true);
    expect(isTownWalkableAt(15, 15)).toBe(false);
  });

  it("routes along walkable cells only", () => {
    const plaza = REGION_POSITIONS.广场;
    const market = REGION_POSITIONS.市场;
    const path = computeTownPath(
      new THREE.Vector3(plaza.x, plaza.y, plaza.z),
      new THREE.Vector3(market.x, market.y, market.z),
    );
    for (const point of path) {
      expect(isTownWalkableAt(point.x, point.z)).toBe(true);
    }
  });
});
