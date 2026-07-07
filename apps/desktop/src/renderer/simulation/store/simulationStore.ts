import type { InteractionResult, SimAgentState } from "@agentcore/contract-types";
import type { SimTickSnapshot } from "@/services/simulation/api";
import { create } from "zustand";
import type { SimAgentPose } from "../pose";
import type { SimulationRunView } from "../runModel";
import {
  seedAgentCards,
  type BigFiveTraits,
  type TownPersonaCard,
} from "../town/townPersonas";
import type { ActiveInteraction } from "../interactionModel";
import type { TownAgentId } from "../town/townRoster";
import { TOWN_AGENT_HOME } from "../town/townRoster";

export type PlaybackMode = "live" | "replay";
export type PlaybackSpeed = 0.5 | 1 | 2 | 4;

export type TickDecisionEntry = {
  tick: number;
  agentId: string;
  summary: string;
  actionType: string;
  location?: string;
};

export type SimStreamEvent = {
  id: string;
  tick: number;
  type: string;
  agentId?: string;
  summary: string;
  timestamp?: string;
  interaction?: InteractionResult;
};

export type SimAgentView = {
  agentId: string;
  name: string;
  role: string;
  bio: string;
  location: string;
  activity: string;
  mood: number;
  goal: string;
  money: number;
  lastThought: string;
  relationships: Record<string, number>;
  bigFive: BigFiveTraits;
};

let simStreamEventSeq = 0;

export function nextSimStreamEventId(): string {
  simStreamEventSeq += 1;
  return `sim-ev-${simStreamEventSeq}`;
}

function cardToView(card: TownPersonaCard): SimAgentView {
  return {
    agentId: card.agentId,
    name: card.name,
    role: card.role,
    bio: card.bio,
    location: TOWN_AGENT_HOME[card.agentId] ?? "",
    activity: "",
    mood: 0,
    goal: card.goal,
    money: 100,
    lastThought: "",
    relationships: { ...card.relationships },
    bigFive: { ...card.bigFive },
  };
}

function mergeAgentState(
  existing: SimAgentView | undefined,
  state: SimAgentState,
  card?: TownPersonaCard,
): SimAgentView {
  const base = existing ?? (card ? cardToView(card) : undefined);
  const relRaw = (state as SimAgentState & { relationships?: Record<string, number> })
    .relationships;
  return {
    agentId: state.agent_id,
    name: state.name || base?.name || state.agent_id,
    role: state.role || base?.role || "",
    bio: base?.bio ?? "",
    location: state.location || base?.location || "",
    activity: state.activity || base?.activity || "",
    mood: state.mood ?? base?.mood ?? 0,
    goal: state.goal || base?.goal || "",
    money: state.money ?? base?.money ?? 100,
    lastThought: state.last_thought || base?.lastThought || "",
    relationships:
      relRaw && Object.keys(relRaw).length > 0
        ? { ...relRaw }
        : { ...(base?.relationships ?? {}) },
    bigFive: base?.bigFive ?? {
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
    },
  };
}

/** Hot path — positions read from R3F useFrame via getState(), never useStore. */
export const useSimulationPositionsStore = create<{
  poses: Record<string, SimAgentPose>;
  setPose: (agentId: string, pose: SimAgentPose) => void;
  setPosesBatch: (next: Record<string, SimAgentPose>) => void;
}>()((set) => ({
  poses: {},
  setPose: (agentId, pose) =>
    set((s) => ({ poses: { ...s.poses, [agentId]: pose } })),
  setPosesBatch: (next) => set((s) => ({ poses: { ...s.poses, ...next } })),
}));

/** Navigation targets — updated per tick from SSE, consumed by NPC path follower. */
export const useSimulationNavStore = create<{
  targets: Record<string, SimVec3Target>;
  setTarget: (agentId: string, target: SimVec3Target) => void;
}>()((set) => ({
  targets: {},
  setTarget: (agentId, target) =>
    set((s) => ({ targets: { ...s.targets, [agentId]: target } })),
}));

export type SimVec3Target = { x: number; y: number; z: number };

export type StreamStatus = "idle" | "connecting" | "connected" | "error";

const personaCards = seedAgentCards();

/** UI / session slice — safe for React subscriptions. */
export const useSimulationUiStore = create<{
  run: SimulationRunView | null;
  streamStatus: StreamStatus;
  streamError: string | null;
  ticking: boolean;
  tickError: string | null;
  decisions: TickDecisionEntry[];
  tickEvents: SimStreamEvent[];
  activeInteractions: Record<string, ActiveInteraction>;
  agents: Record<string, SimAgentView>;
  selectedAgentId: string | null;
  /** Third-person camera follow target; `null` = bird's-eye orbit mode. */
  trackedAgentId: string | null;
  /** `null` = live tail (follow latest tick). */
  playhead: number | null;
  playbackMode: PlaybackMode;
  playing: boolean;
  playbackSpeed: PlaybackSpeed;
  tickCache: Record<number, SimTickSnapshot>;
  setRun: (run: SimulationRunView | null) => void;
  patchRun: (patch: Partial<SimulationRunView>) => void;
  setStreamStatus: (status: StreamStatus, error?: string | null) => void;
  setTicking: (on: boolean) => void;
  setTickError: (msg: string | null) => void;
  pushDecision: (entry: TickDecisionEntry) => void;
  pushTickEvent: (entry: SimStreamEvent) => void;
  upsertActiveInteraction: (interaction: ActiveInteraction) => void;
  pruneExpiredInteractions: (now?: number) => void;
  clearActiveInteractions: () => void;
  clearDecisions: () => void;
  clearTickEvents: () => void;
  upsertAgentState: (state: SimAgentState) => void;
  hydrateAgentsFromSnapshot: (snapshot: SimTickSnapshot) => void;
  seedAgents: () => void;
  setSelectedAgentId: (agentId: string | null) => void;
  setTrackedAgentId: (agentId: string | null) => void;
  startTracking: (agentId: string) => void;
  setPlayhead: (tick: number | null) => void;
  enterReplay: (tick: number) => void;
  goLive: () => void;
  setPlaying: (on: boolean) => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  cacheTickSnapshot: (tick: number, snapshot: SimTickSnapshot) => void;
  resetPlayback: () => void;
  resetSession: () => void;
}>()((set, get) => ({
  run: null,
  streamStatus: "idle",
  streamError: null,
  ticking: false,
  tickError: null,
  decisions: [],
  tickEvents: [],
  activeInteractions: {},
  agents: Object.fromEntries(
    Object.values(personaCards).map((c) => [c.agentId, cardToView(c)]),
  ),
  selectedAgentId: null,
  trackedAgentId: null,
  playhead: null,
  playbackMode: "live",
  playing: false,
  playbackSpeed: 1,
  tickCache: {},
  setRun: (run) => set({ run }),
  patchRun: (patch) =>
    set((s) => (s.run ? { run: { ...s.run, ...patch } } : s)),
  setStreamStatus: (streamStatus, streamError = null) =>
    set({ streamStatus, streamError }),
  setTicking: (ticking) => set({ ticking }),
  setTickError: (tickError) => set({ tickError }),
  pushDecision: (entry) =>
    set((s) => ({ decisions: [entry, ...s.decisions].slice(0, 50) })),
  pushTickEvent: (entry) =>
    set((s) => ({ tickEvents: [entry, ...s.tickEvents].slice(0, 400) })),
  upsertActiveInteraction: (interaction) =>
    set((s) => ({
      activeInteractions: {
        ...s.activeInteractions,
        [interaction.id]: interaction,
      },
    })),
  pruneExpiredInteractions: (now = Date.now()) =>
    set((s) => {
      const next: Record<string, ActiveInteraction> = {};
      for (const [id, item] of Object.entries(s.activeInteractions)) {
        if (item.expiresAt > now) next[id] = item;
      }
      if (Object.keys(next).length === Object.keys(s.activeInteractions).length) {
        return s;
      }
      return { activeInteractions: next };
    }),
  clearActiveInteractions: () => set({ activeInteractions: {} }),
  clearDecisions: () => set({ decisions: [] }),
  clearTickEvents: () => set({ tickEvents: [] }),
  upsertAgentState: (state) =>
    set((s) => {
      const card = personaCards[state.agent_id as TownAgentId];
      const existing = s.agents[state.agent_id];
      return {
        agents: {
          ...s.agents,
          [state.agent_id]: mergeAgentState(existing, state, card),
        },
      };
    }),
  hydrateAgentsFromSnapshot: (snapshot) => {
    const agents = snapshot.agents ?? {};
    if (Object.keys(agents).length === 0) return;
    set((s) => {
      const next = { ...s.agents };
      for (const state of Object.values(agents)) {
        const card = personaCards[state.agent_id as TownAgentId];
        next[state.agent_id] = mergeAgentState(
          next[state.agent_id],
          state,
          card,
        );
      }
      return { agents: next };
    });
  },
  seedAgents: () =>
    set({
      agents: Object.fromEntries(
        Object.values(personaCards).map((c) => [c.agentId, cardToView(c)]),
      ),
    }),
  setSelectedAgentId: (selectedAgentId) => set({ selectedAgentId }),
  setTrackedAgentId: (trackedAgentId) => set({ trackedAgentId }),
  startTracking: (agentId) =>
    set({ trackedAgentId: agentId, selectedAgentId: agentId }),
  setPlayhead: (playhead) =>
    set({
      playhead,
      playbackMode: playhead === null ? "live" : "replay",
    }),
  enterReplay: (tick) =>
    set({
      playhead: tick,
      playbackMode: "replay",
      activeInteractions: {},
      ticking: false,
    }),
  goLive: () =>
    set({
      playhead: null,
      playbackMode: "live",
      playing: false,
    }),
  setPlaying: (playing) => set({ playing }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
  cacheTickSnapshot: (tick, snapshot) => {
    get().hydrateAgentsFromSnapshot(snapshot);
    set((s) => ({
      tickCache: { ...s.tickCache, [tick]: snapshot },
    }));
  },
  resetPlayback: () =>
    set({
      playhead: null,
      playbackMode: "live",
      playing: false,
      playbackSpeed: 1,
      tickCache: {},
    }),
  resetSession: () =>
    set({
      run: null,
      streamStatus: "idle",
      streamError: null,
      ticking: false,
      tickError: null,
      decisions: [],
      tickEvents: [],
      activeInteractions: {},
      selectedAgentId: null,
      trackedAgentId: null,
      playhead: null,
      playbackMode: "live",
      playing: false,
      playbackSpeed: 1,
      tickCache: {},
      agents: Object.fromEntries(
        Object.values(personaCards).map((c) => [c.agentId, cardToView(c)]),
      ),
    }),
}));

/** True while scrubbing or playing back — live SSE deltas must not overwrite. */
export function isReplayActive(): boolean {
  const s = useSimulationUiStore.getState();
  return s.playbackMode === "replay" || s.playhead !== null;
}

/** Agents for replay scrub — tick snapshot wins when cached. */
export function agentsAtViewTick(
  viewTick: number,
  agents: Record<string, SimAgentView>,
  tickCache: Record<number, SimTickSnapshot>,
  replayActive: boolean,
): Record<string, SimAgentView> {
  if (!replayActive || viewTick <= 0) return agents;
  const snapshot = tickCache[viewTick];
  if (!snapshot?.agents || Object.keys(snapshot.agents).length === 0) {
    return agents;
  }
  const next = { ...agents };
  for (const state of Object.values(snapshot.agents)) {
    const card = personaCards[state.agent_id as TownAgentId];
    next[state.agent_id] = mergeAgentState(
      next[state.agent_id],
      state,
      card,
    );
  }
  return next;
}

/** Tick events visible at the current playhead (replay caps at viewTick). */
export function tickEventsAtView(
  tickEvents: SimStreamEvent[],
  viewTick: number,
  replayActive: boolean,
): SimStreamEvent[] {
  if (!replayActive) return tickEvents;
  return tickEvents.filter((ev) => ev.tick <= viewTick);
}

/**
 * Apply a persisted tick snapshot to nav/poses.
 * Replay: snap NPCs to coordinates (poses + targets, no pathfind).
 * Live: update nav targets only — TownNpc path follower handles motion.
 */
export function applyTickSnapshot(snapshot: SimTickSnapshot): void {
  const replay = isReplayActive();
  const agents = snapshot.agents ?? {};
  const poseBatch: Record<string, SimAgentPose> = {};

  useSimulationUiStore.getState().hydrateAgentsFromSnapshot(snapshot);

  for (const [agentId, state] of Object.entries(agents)) {
    const pos = state.position;
    useSimulationNavStore.getState().setTarget(agentId, pos);
    if (replay) {
      const existing = useSimulationPositionsStore.getState().poses[agentId];
      poseBatch[agentId] = {
        ...pos,
        yaw: existing?.yaw ?? 0,
      };
    }
  }

  if (replay && Object.keys(poseBatch).length > 0) {
    useSimulationPositionsStore.getState().setPosesBatch(poseBatch);
  }
}
