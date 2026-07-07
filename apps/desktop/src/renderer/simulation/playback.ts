import {
  type SimTickSnapshot,
  getTickSnapshot,
} from "@/services/simulation/api";
import { MIN_PLAYBACK_TICK } from "@/simulation/jumpTarget";
import {
  applyTickSnapshot,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";

/** Bumps on each seek/goLive so stale async snapshots cannot overwrite a newer view. */
let seekGeneration = 0;

function nextSeekGeneration(): number {
  seekGeneration += 1;
  return seekGeneration;
}

function isSeekStale(gen: number): boolean {
  return gen !== seekGeneration;
}

/** Client-side cache + GET for historical tick frames. */
export async function ensureTickSnapshot(
  runId: string,
  tick: number,
): Promise<SimTickSnapshot> {
  const cached = useSimulationUiStore.getState().tickCache[tick];
  if (cached) return cached;
  const frame = await getTickSnapshot(runId, tick);
  useSimulationUiStore.getState().cacheTickSnapshot(tick, frame.snapshot);
  return frame.snapshot;
}

/** Scrub or step playback to a historical tick (replay mode). */
export async function seekToTick(runId: string, tick: number): Promise<void> {
  const gen = nextSeekGeneration();
  const store = useSimulationUiStore.getState();
  store.enterReplay(tick);
  const snapshot = await ensureTickSnapshot(runId, tick);
  if (isSeekStale(gen)) return;
  if (useSimulationUiStore.getState().playhead !== tick) return;
  applyTickSnapshot(snapshot);
}

/** Return to live tail — apply latest persisted frame, resume SSE consumption. */
export async function goLivePlayback(
  runId: string,
  currentTick: number,
): Promise<void> {
  const gen = nextSeekGeneration();
  const store = useSimulationUiStore.getState();
  store.setPlaying(false);
  if (currentTick > 0) {
    const snapshot = await ensureTickSnapshot(runId, currentTick);
    if (isSeekStale(gen)) return;
    store.goLive();
    applyTickSnapshot(snapshot);
    return;
  }
  store.goLive();
}

/** Step one tick forward or backward during replay. */
export async function stepPlaybackTick(
  runId: string,
  delta: -1 | 1,
): Promise<void> {
  const store = useSimulationUiStore.getState();
  const tail = store.run?.tick ?? 0;
  const cur = store.playhead ?? tail;
  const next = cur + delta;
  if (next < MIN_PLAYBACK_TICK) return;
  if (next >= tail) {
    await goLivePlayback(runId, tail);
    return;
  }
  await seekToTick(runId, next);
}

export function describeTickSnapshot(snapshot: SimTickSnapshot | null): string {
  if (!snapshot) return "等待 tick 落库…";
  const agents = Object.values(snapshot.agents ?? {});
  if (agents.length === 0) {
    return `Tick ${snapshot.tick} · ${snapshot.hour}:00`;
  }
  const lead = agents[0];
  const thought = lead.last_thought?.trim();
  const activity = lead.activity?.trim();
  const detail = thought || activity || lead.location;
  return `Tick ${snapshot.tick} · ${lead.name}${detail ? ` · ${detail}` : ""}`;
}

/** Test hook — reset seek generation between cases. */
export function resetPlaybackSeekGenerationForTests(): void {
  seekGeneration = 0;
}
