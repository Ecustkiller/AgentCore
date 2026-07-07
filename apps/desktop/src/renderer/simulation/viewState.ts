import {
  agentsAtViewTick,
  tickEventsAtView,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";
import { useMemo } from "react";

/** Shared playhead-aware view for panels, heatmap, and timeline. */
export function useSimulationView() {
  const playhead = useSimulationUiStore((s) => s.playhead);
  const playbackMode = useSimulationUiStore((s) => s.playbackMode);
  const runTick = useSimulationUiStore((s) => s.run?.tick);
  const agents = useSimulationUiStore((s) => s.agents);
  const tickCache = useSimulationUiStore((s) => s.tickCache);
  const tickEvents = useSimulationUiStore((s) => s.tickEvents);

  const viewTick = playhead ?? runTick ?? 0;
  const replayActive = playbackMode === "replay" || playhead !== null;

  const viewAgents = useMemo(
    () => agentsAtViewTick(viewTick, agents, tickCache, replayActive),
    [viewTick, agents, tickCache, replayActive],
  );

  const viewEvents = useMemo(
    () => tickEventsAtView(tickEvents, viewTick, replayActive),
    [tickEvents, viewTick, replayActive],
  );

  return { viewTick, viewAgents, viewEvents, replayActive };
}
