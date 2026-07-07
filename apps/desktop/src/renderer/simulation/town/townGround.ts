import type { GroundSurfaceKind } from "./townTextures";

/** Ground paving, roads, and lawn patches — visual only, no nav impact. */

export type GroundPatch = {
  position: readonly [number, number, number];
  size: readonly [number, number];
  color: string;
  surface: GroundSurfaceKind;
  elevation?: number;
};

/** Asphalt roads connecting the seven zones (Y-up, XZ plane). */
export const TOWN_ROADS: readonly GroundPatch[] = [
  // Main east–west artery through plaza
  { position: [8, 0.004, 0], size: [72, 5], color: "#6b7280", surface: "asphalt" },
  // North–south spine through plaza
  { position: [0, 0.004, 6], size: [5, 52], color: "#6b7280", surface: "asphalt" },
  // Market spur (east)
  { position: [24, 0.004, 0], size: [14, 4], color: "#737a82", surface: "asphalt" },
  // Restaurant branch (northeast)
  { position: [30, 0.004, 6], size: [18, 4], color: "#737a82", surface: "asphalt" },
  { position: [36, 0.004, 8], size: [4, 12], color: "#737a82", surface: "asphalt" },
  // Bakery / workplace branch (southeast)
  { position: [24, 0.004, -6], size: [14, 4], color: "#737a82", surface: "asphalt" },
  { position: [24, 0.004, -10], size: [4, 10], color: "#737a82", surface: "asphalt" },
  // Residential branch (north)
  { position: [6, 0.004, 18], size: [4, 16], color: "#737a82", surface: "asphalt" },
  { position: [12, 0.004, 22], size: [12, 4], color: "#737a82", surface: "asphalt" },
  // Town hall approach (southwest)
  { position: [-6, 0.004, -5], size: [16, 4], color: "#737a82", surface: "asphalt" },
  { position: [-12, 0.004, -8], size: [4, 10], color: "#737a82", surface: "asphalt" },
  // Park path (northwest)
  { position: [-9, 0.004, 6], size: [14, 3], color: "#8a9488", surface: "gravel" },
  { position: [-18, 0.004, 4], size: [3, 12], color: "#8a9488", surface: "gravel" },
];

/** Per-zone paved lots and lawns — keyed by region id for clarity. */
export const TOWN_ZONE_GROUNDS: readonly GroundPatch[] = [
  // Plaza cobblestone
  { position: [0, 0.008, 0], size: [12, 12], color: "#b8c4ce", surface: "cobble" },
  // Market courtyard
  { position: [24, 0.007, 0], size: [14, 12], color: "#c4b8a8", surface: "dirt" },
  // Restaurant patio
  { position: [36, 0.007, 12], size: [12, 10], color: "#d4c4b0", surface: "patio" },
  // Bakery yard
  { position: [24, 0.007, -12], size: [14, 10], color: "#b0b8c0", surface: "stone" },
  // Residential block
  { position: [12, 0.007, 24], size: [16, 14], color: "#a8c4a0", surface: "lawn" },
  // Town hall forecourt
  { position: [-12, 0.007, -10], size: [14, 12], color: "#b0b8c8", surface: "cobble" },
  // Park lawn (darker green)
  { position: [-18, 0.006, 6], size: [16, 12], color: "#6aad6a", surface: "grass" },
];
