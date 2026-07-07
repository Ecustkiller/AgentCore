import { computeRegionStats, moodHeatmapStyle } from "@/simulation/regionStats";
import { useSimulationView } from "@/simulation/viewState";
import { useMemo } from "react";
import { TOWN_REGIONS } from "./regionLayout";
import { TOWN_ZONE_GROUNDS } from "./townGround";

/** Semi-transparent mood/density overlay on each zone ground patch. */
export function TownRegionHeatmap() {
  const { viewAgents } = useSimulationView();
  const regionStats = useMemo(
    () => computeRegionStats(viewAgents),
    [viewAgents],
  );

  const overlayByRegion = useMemo(() => {
    const map = new Map<string, (typeof regionStats)[number]>();
    for (const stat of regionStats) {
      map.set(stat.id, stat);
    }
    return map;
  }, [regionStats]);

  return (
    <group>
      {TOWN_REGIONS.map((region) => {
        const stat = overlayByRegion.get(region.id);
        if (!stat || stat.population === 0) return null;

        const ground = TOWN_ZONE_GROUNDS.find(
          (patch) =>
            Math.abs(patch.position[0] - region.center[0]) < 0.5 &&
            Math.abs(patch.position[2] - region.center[2]) < 0.5,
        );
        const [w, d] = ground?.size ?? [10, 10];
        const y = (ground?.elevation ?? ground?.position[1] ?? 0.008) + 0.015;
        const { color, opacity } = moodHeatmapStyle(
          stat.avgMood,
          stat.populationRatio,
        );

        return (
          <mesh
            key={`heat-${region.id}`}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[region.center[0], y, region.center[2]]}
          >
            <planeGeometry args={[w * 0.92, d * 0.92]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={opacity}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}
