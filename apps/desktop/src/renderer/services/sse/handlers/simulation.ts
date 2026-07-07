import { getTickSnapshot } from "@/services/simulation/api";
import type { SimTickSnapshot } from "@/services/simulation/api";
import { activeInteractionFromResult } from "@/simulation/interactionModel";
import { updateSavedRun } from "@/simulation/runHistory";
import { formatSimEventSummary } from "@/simulation/simEventFormat";
import {
  applyTickSnapshot,
  isReplayActive,
  nextSimStreamEventId,
  useSimulationNavStore,
  useSimulationPositionsStore,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";
import type {
  SSEEvent,
  SimAgentActionPayload,
  SimAgentStatePayload,
  SimInteractionPayload,
  SimTickEndedPayload,
  SimTickFramePayload,
  SimTickStartedPayload,
  SimWorldEventPayload,
} from "@agentcore/contract-types";
import type { DispatchContext } from "../types";

const SIM_PREFIX = "sim.";

function isSimEvent(type: string): boolean {
  return type.startsWith(SIM_PREFIX);
}

function applyAgentTarget(
  agentId: string,
  target: { x: number; y: number; z: number },
  yaw?: number,
): void {
  useSimulationNavStore.getState().setTarget(agentId, target);
  const poses = useSimulationPositionsStore.getState().poses;
  if (!poses[agentId]) {
    useSimulationPositionsStore.getState().setPose(agentId, {
      ...target,
      yaw: yaw ?? 0,
    });
  }
}

export interface SimulationDispatchContext {
  runId: string;
}

function recordSimStreamEvent(
  event: Pick<SSEEvent, "type" | "payload" | "timestamp">,
): void {
  const tick =
    typeof (event.payload as { tick?: number }).tick === "number"
      ? (event.payload as { tick: number }).tick
      : (useSimulationUiStore.getState().run?.tick ?? 0);
  const { agentId, summary } = formatSimEventSummary(event.type, event.payload);
  const interaction =
    event.type === "sim.interaction"
      ? (event.payload as SimInteractionPayload).interaction
      : undefined;
  const worldEvent =
    event.type === "sim.world_event"
      ? (event.payload as SimWorldEventPayload).event
      : undefined;
  const modifiers =
    event.type === "sim.world_event"
      ? (event.payload as SimWorldEventPayload).modifiers
      : undefined;
  useSimulationUiStore.getState().pushTickEvent({
    id: nextSimStreamEventId(),
    tick,
    type: event.type,
    agentId,
    summary,
    timestamp: event.timestamp,
    interaction,
    worldEvent,
    modifiers,
  });
}

/** Dedicated simulation SSE stream — updates Zustand slices (FE-04). */
export function dispatchSimulationEvent(
  event: Pick<SSEEvent, "type" | "payload" | "timestamp">,
  ctx: SimulationDispatchContext,
): void {
  if (!isSimEvent(event.type)) return;

  const ui = useSimulationUiStore.getState();
  if (ui.run && ui.run.id !== ctx.runId) return;

  const live = !isReplayActive();
  if (live && event.type !== "sim.tick_frame") {
    recordSimStreamEvent(event);
  }

  switch (event.type) {
    case "sim.tick_started": {
      if (!live) break;
      const p = event.payload as SimTickStartedPayload;
      ui.patchRun({ tick: p.tick, hour: p.hour });
      if (ui.run) updateSavedRun(ui.run.id, { tick: p.tick, hour: p.hour });
      ui.setTickError(null);
      break;
    }
    case "sim.tick_ended": {
      const p = event.payload as SimTickEndedPayload;
      if (live) {
        ui.patchRun({ tick: p.tick, hour: p.hour });
        if (ui.run) updateSavedRun(ui.run.id, { tick: p.tick, hour: p.hour });
        ui.setTicking(false);
        void getTickSnapshot(ctx.runId, p.tick)
          .then((frame) => {
            if (isReplayActive()) return;
            const store = useSimulationUiStore.getState();
            store.cacheTickSnapshot(p.tick, frame.snapshot);
            applyTickSnapshot(frame.snapshot);
          })
          .catch(() => {});
      }
      break;
    }
    case "sim.tick_frame": {
      if (!live) break;
      const p = event.payload as SimTickFramePayload;
      const snapshot = normalizeTickSnapshot(p.tick_number, p.snapshot);
      ui.cacheTickSnapshot(p.tick_number, snapshot);
      applyTickSnapshot(snapshot);
      ui.patchRun({ tick: snapshot.tick, hour: snapshot.hour });
      if (ui.run) {
        updateSavedRun(ui.run.id, {
          tick: snapshot.tick,
          hour: snapshot.hour,
        });
      }
      ui.setTicking(false);
      break;
    }
    case "sim.agent_action": {
      if (!live) break;
      const p = event.payload as SimAgentActionPayload;
      const { action } = p;
      const summary =
        action.thought.trim() ||
        action.detail.trim() ||
        `${action.action}${action.success ? "" : "（失败）"}`;
      const destination =
        typeof action.tool_args?.destination === "string"
          ? action.tool_args.destination
          : undefined;
      ui.pushDecision({
        tick: p.tick,
        agentId: action.agent_id,
        summary,
        actionType: action.action,
        location: destination,
      });
      break;
    }
    case "sim.agent_state": {
      if (!live) break;
      const p = event.payload as SimAgentStatePayload;
      const { state } = p;
      ui.upsertAgentState(state);
      applyAgentTarget(state.agent_id, state.position);
      const current = useSimulationUiStore.getState().decisions;
      if (
        current[0]?.agentId === state.agent_id &&
        current[0]?.tick === p.tick
      ) {
        useSimulationUiStore.setState({
          decisions: [
            { ...current[0], location: state.location },
            ...current.slice(1),
          ],
        });
      }
      break;
    }
    case "sim.interaction": {
      if (!live) break;
      const p = event.payload as SimInteractionPayload;
      const { interaction } = p;
      ui.upsertActiveInteraction(
        activeInteractionFromResult(interaction, p.tick),
      );
      ui.pushDecision({
        tick: p.tick,
        agentId: interaction.initiator_id,
        summary: interaction.summary,
        actionType: interaction.kind,
      });
      break;
    }
    case "sim.world_event": {
      if (!live) break;
      const p = event.payload as SimWorldEventPayload;
      ui.setWorldModifiers(p.modifiers);
      break;
    }
    default:
      break;
  }
}

/**
 * Global SSE bus hook — when sim.* rides a shared stream with simulationRunId set.
 */
export function handleSimulationEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  if (!isSimEvent(event.type)) return false;
  if (ctx.simulationRunId) {
    dispatchSimulationEvent(event, { runId: ctx.simulationRunId });
    return true;
  }
  if (import.meta.env.DEV) {
    console.debug("[sim]", event.type, event.payload);
  }
  return true;
}

/** Coerce replay / SSE tick_frame payload into store snapshot shape. */
export function normalizeTickSnapshot(
  tickNumber: number,
  raw: Record<string, unknown>,
): SimTickSnapshot {
  return {
    tick: typeof raw.tick === "number" ? raw.tick : tickNumber,
    hour: typeof raw.hour === "number" ? raw.hour : 0,
    agents: (raw.agents as SimTickSnapshot["agents"]) ?? {},
    event_log: Array.isArray(raw.event_log) ? (raw.event_log as string[]) : [],
  };
}
