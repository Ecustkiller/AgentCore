import { Environment } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { dayNightPaletteForHour } from "../dayNight";
import { simClockFromTick } from "../simTime";
import {
  modifiersAtViewTick,
  useSimulationUiStore,
} from "../store/simulationStore";
import { useSimulationView } from "../viewState";
import { applyWorldModifierPalette } from "../worldModifierPalette";

export function TownLighting() {
  const run = useSimulationUiStore((s) => s.run);
  const playhead = useSimulationUiStore((s) => s.playhead);
  const { viewModifiers } = useSimulationView();
  const viewTick = playhead ?? run?.tick ?? 0;
  const hour = simClockFromTick(viewTick).hour;

  const palette = useMemo(() => {
    const base = dayNightPaletteForHour(hour);
    return applyWorldModifierPalette(base, viewModifiers);
  }, [hour, viewModifiers]);

  const ambientRef = useRef<THREE.AmbientLight>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();

  useFrame(() => {
    const state = useSimulationUiStore.getState();
    const tick = state.playhead ?? state.run?.tick ?? 0;
    const replayActive =
      state.playbackMode === "replay" || state.playhead !== null;
    const modifiers = modifiersAtViewTick(
      state.worldModifiers,
      state.tickCache,
      tick,
      replayActive,
    );
    const base = dayNightPaletteForHour(simClockFromTick(tick).hour);
    const next = applyWorldModifierPalette(base, modifiers);

    scene.background = new THREE.Color(next.background);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.set(next.fog);
    }

    if (ambientRef.current) {
      ambientRef.current.intensity = next.ambientIntensity;
      ambientRef.current.color.set(next.ambientColor);
    }
    if (hemiRef.current) {
      hemiRef.current.intensity = next.hemiIntensity;
      hemiRef.current.color.set(next.hemiSky);
      hemiRef.current.groundColor.set(next.hemiGround);
    }
    if (sunRef.current) {
      sunRef.current.intensity = next.sunIntensity;
      sunRef.current.color.set(next.sunColor);
      sunRef.current.position.set(...next.sunPosition);
    }
  });

  return (
    <>
      <color attach="background" args={[palette.background]} />
      <fog
        attach="fog"
        args={[
          palette.fog,
          viewModifiers.storm_active ? 55 : 100,
          viewModifiers.storm_active ? 140 : 220,
        ]}
      />
      <ambientLight
        ref={ambientRef}
        intensity={palette.ambientIntensity}
        color={palette.ambientColor}
      />
      <hemisphereLight
        ref={hemiRef}
        args={[palette.hemiSky, palette.hemiGround, palette.hemiIntensity]}
        position={[0, 40, 0]}
      />
      <directionalLight
        ref={sunRef}
        castShadow
        color={palette.sunColor}
        intensity={palette.sunIntensity}
        position={palette.sunPosition}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-far={80}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
      />
      <Environment preset="city" environmentIntensity={palette.envIntensity} />
    </>
  );
}
