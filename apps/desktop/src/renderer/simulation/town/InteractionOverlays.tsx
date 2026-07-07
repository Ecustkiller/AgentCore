import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type ReactNode, useMemo, useRef } from "react";
import type * as THREE from "three";
import {
  type ActiveInteraction,
  interactionSucceeded,
  lastLineForAgent,
  tradeBriefLabel,
  truncateInteractionText,
  voteGovernanceDetails,
} from "../interactionModel";
import { locationCenter } from "../regionPositions";
import {
  useSimulationPositionsStore,
  useSimulationUiStore,
} from "../store/simulationStore";

const BUBBLE_Y = 2.65;
const TRADE_Y = 2.4;
const VOTE_Y = 6.5;

function useActiveInteractionList(): ActiveInteraction[] {
  const map = useSimulationUiStore((s) => s.activeInteractions);
  return useMemo(() => Object.values(map), [map]);
}

function InteractionExpiryJanitor() {
  const lastPrune = useRef(0);

  useFrame(() => {
    const now = Date.now();
    if (now - lastPrune.current < 400) return;
    lastPrune.current = now;
    useSimulationUiStore.getState().pruneExpiredInteractions(now);
  });

  return null;
}

function AgentAnchoredHtml({
  agentId,
  yOffset,
  children,
}: {
  agentId: string;
  yOffset: number;
  children: ReactNode;
}) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const pose = useSimulationPositionsStore.getState().poses[agentId];
    if (!pose) return;
    group.position.set(pose.x, pose.y + yOffset, pose.z);
  });

  return (
    <group ref={groupRef}>
      <Html center distanceFactor={13} style={{ pointerEvents: "none" }}>
        {children}
      </Html>
    </group>
  );
}

function BetweenAgentsAnchor({
  agentA,
  agentB,
  yOffset,
  children,
}: {
  agentA: string;
  agentB: string;
  yOffset: number;
  children: ReactNode;
}) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const poses = useSimulationPositionsStore.getState().poses;
    const a = poses[agentA];
    const b = poses[agentB];
    if (!a || !b) return;
    group.position.set(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2 + yOffset,
      (a.z + b.z) / 2,
    );
  });

  return (
    <group ref={groupRef}>
      <Html center distanceFactor={14} style={{ pointerEvents: "none" }}>
        {children}
      </Html>
    </group>
  );
}

function InteractionConnectionLine({
  agentA,
  agentB,
}: {
  agentA: string;
  agentB: string;
}) {
  const geomRef = useRef<THREE.BufferGeometry>(null);
  const lineRef = useRef<THREE.Line>(null);
  const lineHeight = 2.2;

  useFrame(() => {
    const geom = geomRef.current;
    if (!geom) return;
    const poses = useSimulationPositionsStore.getState().poses;
    const a = poses[agentA];
    const b = poses[agentB];
    if (!a || !b) return;
    const arr = geom.attributes.position.array as Float32Array;
    arr[0] = a.x;
    arr[1] = a.y + lineHeight;
    arr[2] = a.z;
    arr[3] = b.x;
    arr[4] = b.y + lineHeight;
    arr[5] = b.z;
    geom.attributes.position.needsUpdate = true;
    lineRef.current?.computeLineDistances();
  });

  return (
    // R3F three.js line — not SVG <line>
    <line ref={lineRef as never}>
      <bufferGeometry ref={geomRef}>
        <bufferAttribute
          attach="attributes-position"
          args={[new Float32Array(6), 3]}
          count={2}
        />
      </bufferGeometry>
      <lineDashedMaterial
        color="#7ec8e8"
        dashSize={0.45}
        gapSize={0.28}
        transparent
        opacity={0.9}
      />
    </line>
  );
}

function ConversationSpeechBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[9rem] rounded-xl border border-border bg-card/95 px-2 py-1 text-xs leading-snug text-foreground shadow-md backdrop-blur-sm">
      {truncateInteractionText(text, 44)}
    </div>
  );
}

function ConversationOverlay({
  interaction,
}: { interaction: ActiveInteraction }) {
  const targetId = interaction.targetId;
  if (!targetId) return null;

  const initiatorLine =
    lastLineForAgent(interaction.transcript, interaction.initiatorId) ??
    interaction.summary;
  const targetLine =
    lastLineForAgent(interaction.transcript, targetId) ?? interaction.summary;

  return (
    <group>
      <InteractionConnectionLine
        agentA={interaction.initiatorId}
        agentB={targetId}
      />
      <AgentAnchoredHtml agentId={interaction.initiatorId} yOffset={BUBBLE_Y}>
        <ConversationSpeechBubble text={initiatorLine} />
      </AgentAnchoredHtml>
      <AgentAnchoredHtml agentId={targetId} yOffset={BUBBLE_Y}>
        <ConversationSpeechBubble text={targetLine} />
      </AgentAnchoredHtml>
    </group>
  );
}

function TradeOverlay({ interaction }: { interaction: ActiveInteraction }) {
  const targetId = interaction.targetId;
  if (!targetId) return null;

  const ok = interactionSucceeded(interaction.status);
  const tone = ok
    ? "border-success/60 bg-success/10 text-success"
    : "border-destructive/60 bg-destructive/10 text-destructive";

  return (
    <BetweenAgentsAnchor
      agentA={interaction.initiatorId}
      agentB={targetId}
      yOffset={TRADE_Y}
    >
      <div
        className={`flex flex-col items-center gap-0.5 rounded-xl border px-2.5 py-1.5 text-xs shadow-md backdrop-blur-sm ${tone}`}
      >
        <span className="text-base leading-none">💰</span>
        <span className="max-w-[8rem] text-center font-medium">
          {tradeBriefLabel(interaction)}
        </span>
        <span className="text-xs opacity-90">{ok ? "成交" : "未成交"}</span>
      </div>
    </BetweenAgentsAnchor>
  );
}

function VoteOverlay({ interaction }: { interaction: ActiveInteraction }) {
  const [cx, , cz] = locationCenter("镇政厅");
  const groupRef = useRef<THREE.Group>(null);
  const { motion, outcome, yes, no, abstain } = voteGovernanceDetails(
    interaction.stateChanges,
  );
  const title = motion || truncateInteractionText(interaction.summary, 36);
  const resolved = outcome.length > 0;
  const outcomeTone =
    outcome === "通过"
      ? "text-success"
      : outcome === "否决"
        ? "text-destructive"
        : "text-foreground";

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    group.position.set(cx, 0, cz);
  });

  return (
    <group ref={groupRef}>
      <Html
        position={[0, VOTE_Y, 0]}
        center
        distanceFactor={20}
        style={{ pointerEvents: "none" }}
      >
        <div className="min-w-[10rem] max-w-[14rem] rounded-xl border border-border bg-card/95 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur-sm">
          <div className="font-medium">镇政厅投票</div>
          <p className="mt-1 leading-snug">{title}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
            <span>支持 {yes}</span>
            <span>反对 {no}</span>
            <span>弃权 {abstain}</span>
          </div>
          {resolved ? (
            <p className={`mt-1 font-medium ${outcomeTone}`}>结果：{outcome}</p>
          ) : (
            <p className="mt-1 text-muted-foreground">计票中…</p>
          )}
        </div>
      </Html>
    </group>
  );
}

function InteractionOverlayItem({
  interaction,
}: { interaction: ActiveInteraction }) {
  switch (interaction.kind) {
    case "conversation":
      return <ConversationOverlay interaction={interaction} />;
    case "trade":
      return <TradeOverlay interaction={interaction} />;
    case "vote":
      return <VoteOverlay interaction={interaction} />;
    default:
      return null;
  }
}

/** 3D overlays for active sim.interaction events (bubbles, trade icons, vote HUD). */
export function InteractionOverlays() {
  const interactions = useActiveInteractionList();

  return (
    <>
      <InteractionExpiryJanitor />
      {interactions.map((interaction) => (
        <InteractionOverlayItem
          key={interaction.id}
          interaction={interaction}
        />
      ))}
    </>
  );
}
