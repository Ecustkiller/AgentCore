import {
  OrbitControls,
  PerspectiveCamera,
  useGLTF,
  useTexture,
} from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Loader2 } from "lucide-react";
import { Suspense, useLayoutEffect, useMemo, useRef } from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useSimulationUiStore } from "../store/simulationStore";
import { InteractionOverlays } from "./InteractionOverlays";
import { TownLighting } from "./TownLighting";
import { TownNpc } from "./TownNpc";
import { TownRegionHeatmap } from "./TownRegionHeatmap";
import { TownRegions } from "./TownRegions";
import { TownWorldEffects } from "./TownWorldEffects";
import { TrackingCamera } from "./TrackingCamera";
import { buildTownSpawnTable, seedTownSpawnsIfNeeded } from "./agentSpawn";
import { TOWN_GLB_URLS } from "./assetPaths";
import { TOWN_VIEW_CENTER } from "./regionLayout";
import { TownCharacterAssetsProvider } from "./townCharacterAssets";
import { townColormapUrls } from "./townGltfUtils";
import { type LodLevel, TOWN_CAMERA_POS, computeLodLevel } from "./townLod";
import { TOWN_AGENT_IDS } from "./townRoster";
import type { TownAgentId } from "./townRoster";

function TownSceneContent() {
  const spawnTable = useMemo(() => buildTownSpawnTable(), []);
  const initialLodByAgent = useMemo(() => {
    const map = {} as Record<TownAgentId, LodLevel>;
    for (const id of TOWN_AGENT_IDS) {
      map[id] = computeLodLevel(TOWN_CAMERA_POS, spawnTable[id]);
    }
    return map;
  }, [spawnTable]);

  useLayoutEffect(() => {
    seedTownSpawnsIfNeeded(spawnTable);
  }, [spawnTable]);

  const [cx, , cz] = TOWN_VIEW_CENTER;
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const trackedAgentId = useSimulationUiStore((s) => s.trackedAgentId);

  return (
    <TownCharacterAssetsProvider>
      <TownLighting />
      <TownWorldEffects />
      <PerspectiveCamera makeDefault position={[...TOWN_CAMERA_POS]} fov={44} />
      <OrbitControls
        ref={controlsRef}
        enabled={!trackedAgentId}
        enablePan
        maxPolarAngle={Math.PI / 2.15}
        minDistance={12}
        maxDistance={72}
        target={[cx, 0, cz]}
      />
      <TrackingCamera controlsRef={controlsRef} />
      <TownRegions />
      <TownRegionHeatmap />
      {TOWN_AGENT_IDS.map((id) => (
        <TownNpc
          key={id}
          agentId={id}
          spawnPosition={spawnTable[id]}
          initialLod={initialLodByAgent[id]}
        />
      ))}
      <InteractionOverlays />
    </TownCharacterAssetsProvider>
  );
}

function TownCanvasLoading() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background">
      <Loader2 size={32} className="animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">加载 3D 场景…</p>
    </div>
  );
}

export function TownCanvas() {
  return (
    <Suspense fallback={<TownCanvasLoading />}>
      <Canvas
        shadows
        className="h-full w-full"
        dpr={[1, 1.5]}
        data-town-canvas="ready"
      >
        <TownSceneContent />
      </Canvas>
    </Suspense>
  );
}

for (const url of TOWN_GLB_URLS) {
  useGLTF.preload(url);
}
for (const url of townColormapUrls(TOWN_GLB_URLS)) {
  useTexture.preload(url);
}
