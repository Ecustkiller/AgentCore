import type { TownLocationId } from "../regionPositions";
import { locationCenter } from "../regionPositions";
import { KENNEY_BUILDINGS } from "./assetPaths";

export type TownModelDef = {
  url: string;
  position: readonly [number, number, number];
  rotationY?: number;
  scale?: number;
  /** Small props skip shadow casting for perf. */
  castShadow?: boolean;
};

export type TownRegionDef = {
  id: TownLocationId;
  label: string;
  center: readonly [number, number, number];
  models: readonly TownModelDef[];
};

function off(
  center: readonly [number, number, number],
  dx: number,
  dz: number,
  y = 0,
): [number, number, number] {
  return [center[0] + dx, center[1] + y, center[2] + dz];
}

/** Seven gameplay zones aligned with backend REGION_POSITIONS (Y-up). */
export const TOWN_REGIONS: readonly TownRegionDef[] = [
  {
    id: "广场",
    label: "广场",
    center: locationCenter("广场"),
    models: [
      // Enclosure buildings around the cobblestone plaza
      {
        url: KENNEY_BUILDINGS.plazaWide,
        position: off(locationCenter("广场"), -5, -5),
        rotationY: Math.PI / 2,
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.plazaWideB,
        position: off(locationCenter("广场"), 5, -5),
        rotationY: -Math.PI / 2,
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.accentC,
        position: off(locationCenter("广场"), -5, 5),
        rotationY: Math.PI,
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.accentD,
        position: off(locationCenter("广场"), 5, 5),
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.accentA,
        position: off(locationCenter("广场"), 0, -5),
        rotationY: Math.PI,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.accentB,
        position: off(locationCenter("广场"), 0, 5),
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.shopA,
        position: off(locationCenter("广场"), -5, 0),
        rotationY: Math.PI / 2,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.shopB,
        position: off(locationCenter("广场"), 5, 0),
        rotationY: -Math.PI / 2,
        scale: 0.9,
      },
      // Road-side accents along main artery
      {
        url: KENNEY_BUILDINGS.roadAccentA,
        position: off(locationCenter("广场"), -7, 0),
        rotationY: Math.PI / 2,
        scale: 0.85,
      },
      {
        url: KENNEY_BUILDINGS.roadAccentB,
        position: off(locationCenter("广场"), 7, 0),
        rotationY: -Math.PI / 2,
        scale: 0.85,
      },
      // Central parasols
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("广场"), -2, 1),
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("广场"), 2, -1),
        rotationY: 0.8,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("广场"), 0, 2),
        rotationY: 1.5,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.awning,
        position: off(locationCenter("广场"), -1, -2),
        rotationY: 0.3,
        scale: 0.9,
        castShadow: false,
      },
    ],
  },
  {
    id: "市场",
    label: "市场",
    center: locationCenter("市场"),
    models: [
      // Shop row along south edge
      {
        url: KENNEY_BUILDINGS.shopA,
        position: off(locationCenter("市场"), -5, -4),
        rotationY: Math.PI,
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.shopB,
        position: off(locationCenter("市场"), -2, -4),
        rotationY: Math.PI,
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.shopC,
        position: off(locationCenter("市场"), 1, -4),
        rotationY: Math.PI,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.shopD,
        position: off(locationCenter("市场"), 4, -4),
        rotationY: Math.PI,
        scale: 0.95,
      },
      // Shop row along north edge
      {
        url: KENNEY_BUILDINGS.shopE,
        position: off(locationCenter("市场"), -5, 4),
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.shopF,
        position: off(locationCenter("市场"), -2, 4),
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.accentB,
        position: off(locationCenter("市场"), 1, 4),
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.accentE,
        position: off(locationCenter("市场"), 4, 4),
        scale: 0.95,
      },
      // West edge shops (toward plaza road)
      {
        url: KENNEY_BUILDINGS.houseB,
        position: off(locationCenter("市场"), -6, 0),
        rotationY: Math.PI / 2,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.houseC,
        position: off(locationCenter("市场"), -6, 3),
        rotationY: Math.PI / 2,
        scale: 0.88,
      },
      // East edge
      {
        url: KENNEY_BUILDINGS.houseD,
        position: off(locationCenter("市场"), 6, -1),
        rotationY: -Math.PI / 2,
        scale: 0.9,
      },
      // Market stalls & awnings in courtyard
      {
        url: KENNEY_BUILDINGS.marketAwning,
        position: off(locationCenter("市场"), 0, 1),
        rotationY: Math.PI / 6,
        scale: 1.1,
      },
      {
        url: KENNEY_BUILDINGS.awning,
        position: off(locationCenter("市场"), -3, 0),
        rotationY: Math.PI / 2,
        scale: 1.05,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.awning,
        position: off(locationCenter("市场"), 3, 0),
        rotationY: -Math.PI / 2,
        scale: 1.05,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.awning,
        position: off(locationCenter("市场"), 0, -1),
        rotationY: Math.PI,
        scale: 1.0,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.overhangWide,
        position: off(locationCenter("市场"), 2, -1),
        rotationY: Math.PI / 4,
        scale: 0.95,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.overhang,
        position: off(locationCenter("市场"), -2, 2),
        rotationY: -Math.PI / 6,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("市场"), 3, 2),
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("市场"), -3, -2),
        rotationY: 1.0,
        castShadow: false,
      },
    ],
  },
  {
    id: "餐厅",
    label: "餐厅",
    center: locationCenter("餐厅"),
    models: [
      // Main restaurant buildings
      {
        url: KENNEY_BUILDINGS.restaurant,
        position: off(locationCenter("餐厅"), 0, 2),
        rotationY: -Math.PI / 5,
        scale: 1.15,
      },
      {
        url: KENNEY_BUILDINGS.restaurantB,
        position: off(locationCenter("餐厅"), -4, -1),
        rotationY: Math.PI / 3,
        scale: 1.05,
      },
      {
        url: KENNEY_BUILDINGS.restaurantC,
        position: off(locationCenter("餐厅"), 4, -1),
        rotationY: -Math.PI / 3,
        scale: 1.0,
      },
      {
        url: KENNEY_BUILDINGS.shopA,
        position: off(locationCenter("餐厅"), -4, 3),
        rotationY: Math.PI / 4,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.shopB,
        position: off(locationCenter("餐厅"), 4, 3),
        rotationY: -Math.PI / 4,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.houseA,
        position: off(locationCenter("餐厅"), 0, -4),
        rotationY: Math.PI,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.houseB,
        position: off(locationCenter("餐厅"), -5, -4),
        rotationY: (3 * Math.PI) / 4,
        scale: 0.88,
      },
      // Road-side accent toward main road
      {
        url: KENNEY_BUILDINGS.roadAccentA,
        position: off(locationCenter("餐厅"), 5, 0),
        rotationY: -Math.PI / 2,
        scale: 0.85,
      },
      // Outdoor dining area
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("餐厅"), -2, 4),
        rotationY: 0.5,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("餐厅"), 1, 4),
        rotationY: 1.2,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("餐厅"), 3, 3),
        rotationY: 2.0,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("餐厅"), -1, 1),
        rotationY: 0.8,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.overhang,
        position: off(locationCenter("餐厅"), 2, -3),
        rotationY: Math.PI,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.awning,
        position: off(locationCenter("餐厅"), -2, -3),
        rotationY: Math.PI / 2,
        castShadow: false,
      },
    ],
  },
  {
    id: "面包店",
    label: "面包店",
    center: locationCenter("面包店"),
    models: [
      // Workshop cluster
      {
        url: KENNEY_BUILDINGS.workshopA,
        position: off(locationCenter("面包店"), -4, 0),
        rotationY: Math.PI / 2,
        scale: 1.1,
      },
      {
        url: KENNEY_BUILDINGS.workshopB,
        position: off(locationCenter("面包店"), 4, 0),
        rotationY: -Math.PI / 2,
        scale: 1.1,
      },
      {
        url: KENNEY_BUILDINGS.workshopC,
        position: off(locationCenter("面包店"), 0, -4),
        rotationY: Math.PI,
        scale: 1.05,
      },
      {
        url: KENNEY_BUILDINGS.workshopD,
        position: off(locationCenter("面包店"), -2, 3),
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.houseC,
        position: off(locationCenter("面包店"), 2, 3),
        rotationY: -Math.PI / 6,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.houseD,
        position: off(locationCenter("面包店"), -5, -3),
        rotationY: Math.PI / 4,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.houseE,
        position: off(locationCenter("面包店"), 5, -3),
        rotationY: -Math.PI / 4,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.accentA,
        position: off(locationCenter("面包店"), 0, 4),
        scale: 0.88,
      },
      // Road-side toward market
      {
        url: KENNEY_BUILDINGS.roadAccentB,
        position: off(locationCenter("面包店"), -6, 0),
        rotationY: Math.PI / 2,
        scale: 0.85,
      },
      {
        url: KENNEY_BUILDINGS.overhangWide,
        position: off(locationCenter("面包店"), 3, 3),
        rotationY: -Math.PI / 6,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.awning,
        position: off(locationCenter("面包店"), -3, 3),
        rotationY: Math.PI / 3,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("面包店"), 1, -2),
        castShadow: false,
      },
    ],
  },
  {
    id: "住宅区",
    label: "住宅区",
    center: locationCenter("住宅区"),
    models: [
      // Front row (south, toward road)
      {
        url: KENNEY_BUILDINGS.houseA,
        position: off(locationCenter("住宅区"), -4, -5),
        rotationY: Math.PI,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.houseB,
        position: off(locationCenter("住宅区"), -1, -5),
        rotationY: Math.PI,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.houseC,
        position: off(locationCenter("住宅区"), 2, -5),
        rotationY: Math.PI,
        scale: 0.93,
      },
      {
        url: KENNEY_BUILDINGS.houseD,
        position: off(locationCenter("住宅区"), 5, -5),
        rotationY: Math.PI,
        scale: 0.93,
      },
      // Middle row
      {
        url: KENNEY_BUILDINGS.houseE,
        position: off(locationCenter("住宅区"), -5, -2),
        rotationY: Math.PI / 2,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.houseF,
        position: off(locationCenter("住宅区"), -2, -2),
        rotationY: Math.PI / 4,
        scale: 0.93,
      },
      {
        url: KENNEY_BUILDINGS.houseG,
        position: off(locationCenter("住宅区"), 1, -2),
        rotationY: -Math.PI / 4,
        scale: 0.93,
      },
      {
        url: KENNEY_BUILDINGS.houseA,
        position: off(locationCenter("住宅区"), 4, -2),
        rotationY: -Math.PI / 2,
        scale: 0.95,
      },
      // Center row
      {
        url: KENNEY_BUILDINGS.houseB,
        position: off(locationCenter("住宅区"), -3, 1),
        rotationY: Math.PI / 2,
        scale: 0.93,
      },
      {
        url: KENNEY_BUILDINGS.houseC,
        position: off(locationCenter("住宅区"), 0, 1),
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.houseD,
        position: off(locationCenter("住宅区"), 3, 1),
        rotationY: -Math.PI / 2,
        scale: 0.93,
      },
      // Back row (north)
      {
        url: KENNEY_BUILDINGS.houseE,
        position: off(locationCenter("住宅区"), -4, 4),
        rotationY: (3 * Math.PI) / 4,
        scale: 0.93,
      },
      {
        url: KENNEY_BUILDINGS.houseF,
        position: off(locationCenter("住宅区"), -1, 4),
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.houseG,
        position: off(locationCenter("住宅区"), 2, 4),
        scale: 0.93,
      },
      {
        url: KENNEY_BUILDINGS.houseA,
        position: off(locationCenter("住宅区"), 5, 4),
        rotationY: (-3 * Math.PI) / 4,
        scale: 0.93,
      },
      // Road-side accents along residential branch
      {
        url: KENNEY_BUILDINGS.roadAccentA,
        position: off(locationCenter("住宅区"), 0, -7),
        rotationY: Math.PI,
        scale: 0.85,
      },
      {
        url: KENNEY_BUILDINGS.roadAccentB,
        position: off(locationCenter("住宅区"), -6, -2),
        rotationY: Math.PI / 2,
        scale: 0.85,
      },
    ],
  },
  {
    id: "镇政厅",
    label: "镇政厅",
    center: locationCenter("镇政厅"),
    models: [
      // Skyscraper civic center
      {
        url: KENNEY_BUILDINGS.townHall,
        position: off(locationCenter("镇政厅"), 0, -2),
        scale: 1.25,
      },
      {
        url: KENNEY_BUILDINGS.townHallB,
        position: off(locationCenter("镇政厅"), -5, 0),
        rotationY: Math.PI / 6,
        scale: 1.05,
      },
      {
        url: KENNEY_BUILDINGS.skyscraperA,
        position: off(locationCenter("镇政厅"), 5, 0),
        rotationY: -Math.PI / 6,
        scale: 1.0,
      },
      // Supporting low-rise buildings
      {
        url: KENNEY_BUILDINGS.accentB,
        position: off(locationCenter("镇政厅"), -4, 4),
        rotationY: Math.PI,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.accentC,
        position: off(locationCenter("镇政厅"), 4, 4),
        rotationY: Math.PI,
        scale: 0.95,
      },
      {
        url: KENNEY_BUILDINGS.shopA,
        position: off(locationCenter("镇政厅"), -5, -4),
        rotationY: Math.PI / 3,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.shopB,
        position: off(locationCenter("镇政厅"), 5, -4),
        rotationY: -Math.PI / 3,
        scale: 0.9,
      },
      {
        url: KENNEY_BUILDINGS.skyscraperD,
        position: off(locationCenter("镇政厅"), 0, 4),
        scale: 0.85,
      },
      // Forecourt props
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("镇政厅"), -2, 3),
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("镇政厅"), 2, 3),
        rotationY: 1.2,
        castShadow: false,
      },
      // Road approach accents
      {
        url: KENNEY_BUILDINGS.roadAccentA,
        position: off(locationCenter("镇政厅"), -7, -2),
        rotationY: Math.PI / 2,
        scale: 0.85,
      },
      {
        url: KENNEY_BUILDINGS.roadAccentB,
        position: off(locationCenter("镇政厅"), 0, -6),
        rotationY: Math.PI,
        scale: 0.85,
      },
    ],
  },
  {
    id: "公园",
    label: "公园",
    center: locationCenter("公园"),
    models: [
      // Scattered parasols across the lawn
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("公园"), -5, 2),
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("公园"), 2, 1),
        rotationY: 1.2,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("公园"), -1, -3),
        rotationY: 0.4,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("公园"), 4, -1),
        rotationY: 2.1,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("公园"), -3, -1),
        rotationY: 0.6,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolB,
        position: off(locationCenter("公园"), 1, 4),
        rotationY: 1.8,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("公园"), 5, 3),
        rotationY: 2.5,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.parasolA,
        position: off(locationCenter("公园"), 0, 0),
        rotationY: 0.9,
        castShadow: false,
      },
      // Overhangs as bench shelters
      {
        url: KENNEY_BUILDINGS.overhang,
        position: off(locationCenter("公园"), -4, -4),
        rotationY: Math.PI / 4,
        scale: 0.9,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.overhang,
        position: off(locationCenter("公园"), 3, -3),
        rotationY: -Math.PI / 3,
        scale: 0.9,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.overhangWide,
        position: off(locationCenter("公园"), -2, 4),
        rotationY: Math.PI / 6,
        scale: 0.85,
        castShadow: false,
      },
      {
        url: KENNEY_BUILDINGS.awning,
        position: off(locationCenter("公园"), 5, 1),
        rotationY: -Math.PI / 4,
        scale: 0.9,
        castShadow: false,
      },
      // Small pavilion at park edge (not blocking open center)
      {
        url: KENNEY_BUILDINGS.houseD,
        position: off(locationCenter("公园"), -6, -4),
        rotationY: Math.PI / 3,
        scale: 0.8,
      },
      {
        url: KENNEY_BUILDINGS.accentA,
        position: off(locationCenter("公园"), 6, 4),
        rotationY: -Math.PI / 4,
        scale: 0.75,
      },
      // Path-side accents
      {
        url: KENNEY_BUILDINGS.roadAccentA,
        position: off(locationCenter("公园"), 6, -2),
        rotationY: -Math.PI / 2,
        scale: 0.8,
      },
    ],
  },
] as const;

export function regionCenter(id: TownLocationId): [number, number, number] {
  return locationCenter(id);
}

/** Approximate town centroid for camera framing (not a gameplay anchor). */
export const TOWN_VIEW_CENTER: readonly [number, number, number] = [9, 0, 5];
