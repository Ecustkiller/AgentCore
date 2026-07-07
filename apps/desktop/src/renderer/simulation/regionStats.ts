import { TOWN_LOCATION_IDS, type TownLocationId } from "./regionPositions";
import { TOWN_REGIONS } from "./town/regionLayout";
import type { SimAgentView } from "./store/simulationStore";

export type RegionStat = {
  id: TownLocationId;
  label: string;
  population: number;
  avgMood: number;
  populationRatio: number;
};

export type MoodBand = "good" | "medium" | "bad";

/** Mood is on [-1, 1] in the simulation model. */
export function moodBand(mood: number): MoodBand {
  if (mood > 0.3) return "good";
  if (mood < -0.3) return "bad";
  return "medium";
}

export function moodBandClass(band: MoodBand): string {
  switch (band) {
    case "good":
      return "bg-success";
    case "bad":
      return "bg-destructive";
    default:
      return "bg-warning";
  }
}

/** Heatmap tint for 3D overlay — mood drives hue, population drives alpha. */
export function moodHeatmapStyle(
  mood: number,
  populationRatio: number,
): { color: string; opacity: number } {
  const band = moodBand(mood);
  const opacity = 0.12 + populationRatio * 0.28;
  switch (band) {
    case "good":
      return { color: "#22c55e", opacity };
    case "bad":
      return { color: "#ef4444", opacity };
    default:
      return { color: "#eab308", opacity };
  }
}

export function computeRegionStats(
  agents: Record<string, SimAgentView>,
): RegionStat[] {
  const byRegion = new Map<TownLocationId, SimAgentView[]>();
  for (const id of TOWN_LOCATION_IDS) {
    byRegion.set(id, []);
  }

  for (const agent of Object.values(agents)) {
    const loc = agent.location as TownLocationId;
    if (byRegion.has(loc)) {
      byRegion.get(loc)?.push(agent);
    }
  }

  const totalAgents = Object.keys(agents).length || 1;

  return TOWN_REGIONS.map((region) => {
    const residents = byRegion.get(region.id) ?? [];
    const population = residents.length;
    const avgMood =
      population > 0
        ? residents.reduce((sum, a) => sum + a.mood, 0) / population
        : 0;
    return {
      id: region.id,
      label: region.label,
      population,
      avgMood,
      populationRatio: population / totalAgents,
    };
  });
}
