import { Html, useAnimations } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { CharacterTemplate } from "./townCharacterAssets";
import type { LodLevel } from "./townLod";
import type { TownAgentId } from "./townRoster";
import { TOWN_AGENT_NAMES } from "./townRoster";
import { townRenderDebug } from "./townRenderDebug";

type AnimState = "idle" | "walk";

function NpcNameLabel({ name }: { name: string }) {
  return (
    <Html
      position={[0, 2.1, 0]}
      center
      distanceFactor={14}
      style={{ pointerEvents: "none" }}
    >
      <span className="rounded-lg border border-border bg-card/90 px-1.5 py-0.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm">
        {name}
      </span>
    </Html>
  );
}

function applyMeshLod(root: THREE.Object3D, lod: LodLevel): void {
  const castShadow = lod === "near";
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = castShadow;
    }
  });
}

export function NpcAvatar({
  template,
  agentId,
  lod,
  walking,
  animEnabled,
}: {
  template: CharacterTemplate;
  agentId: TownAgentId;
  lod: LodLevel;
  walking: boolean;
  animEnabled: boolean;
}) {
  const modelRef = useRef<THREE.Object3D>(null);
  const animState = useRef<AnimState>("idle");
  const model = useMemo(() => template.createInstance(), [template]);
  const { actions, mixer } = useAnimations(template.animations, modelRef);

  const idleAction =
    actions.idle ?? actions["mixamo.com"] ?? Object.values(actions)[0];
  const walkAction = actions.walk ?? actions["mixamo.com"] ?? idleAction;

  useEffect(() => {
    townRenderDebug.animBind({
      agentId,
      actionNames: Object.keys(actions),
    });
  }, [agentId, actions]);

  useEffect(() => {
    applyMeshLod(model, lod);
  }, [model, lod]);

  useEffect(() => {
    if (!idleAction || !animEnabled) return;
    idleAction.reset().fadeIn(0.2).play();
    animState.current = "idle";
    return () => {
      idleAction.fadeOut(0.2);
    };
  }, [idleAction, animEnabled]);

  useEffect(() => {
    if (!animEnabled) return;
    const next: AnimState = walking ? "walk" : "idle";
    if (animState.current === next) return;
    animState.current = next;
    const from = next === "walk" ? idleAction : walkAction;
    const to = next === "walk" ? walkAction : idleAction;
    if (!to) return;
    from?.fadeOut(0.15);
    to.reset().fadeIn(0.15).play();
  }, [walking, animEnabled, idleAction, walkAction]);

  useFrame((_, delta) => {
    if (animEnabled) {
      mixer?.update(delta);
    }
  });

  return (
    <>
      {lod !== "far" ? <primitive ref={modelRef} object={model} /> : null}
      {lod === "far" ? (
        <mesh position={[0, 0.9, 0]} castShadow={false}>
          <capsuleGeometry args={[0.28, 1.1, 4, 8]} />
          <meshStandardMaterial color="#7a96b8" roughness={0.85} />
        </mesh>
      ) : null}
      {lod === "near" ? (
        <NpcNameLabel name={TOWN_AGENT_NAMES[agentId]} />
      ) : null}
    </>
  );
}
