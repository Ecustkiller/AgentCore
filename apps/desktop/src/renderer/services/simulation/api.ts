import { api } from "@/services/api";
import {
  type AdvanceTickResponseWire,
  type CreateSimulationRunRequestWire,
  type SimulationRunView,
  hourForTick,
  runFromWire,
} from "@/simulation/runModel";
import type { components } from "@agentcore/contract-rest-types";
import type { SimAgentState } from "@agentcore/contract-types";

export async function createSimulationRun(
  body: Partial<CreateSimulationRunRequestWire> = {},
): Promise<SimulationRunView> {
  const raw = await api.post<components["schemas"]["SimulationRunSummary"]>(
    "/v1/simulation/runs",
    {
      scenario: body.scenario ?? "town",
      seed: body.seed,
    },
  );
  return runFromWire(raw);
}

export async function advanceSimulationTick(
  runId: string,
): Promise<{ tick: number; hour: number }> {
  const raw = await api.post<AdvanceTickResponseWire>(
    `/v1/simulation/runs/${encodeURIComponent(runId)}/tick`,
    {},
  );
  return { tick: raw.snapshot.tick, hour: raw.snapshot.hour };
}

export type SimTickSnapshot = components["schemas"]["SimTickSnapshot"];
export type SimTickFrameResponse =
  components["schemas"]["SimTickFrameResponse"];

/** Fetch a persisted tick frame (replay source — no recomputation). */
export async function getTickSnapshot(
  runId: string,
  tickNumber: number,
): Promise<SimTickFrameResponse> {
  return api.get<SimTickFrameResponse>(
    `/v1/simulation/runs/${encodeURIComponent(runId)}/ticks/${tickNumber}`,
  );
}

/** Wire shape for pause/resume (not yet in committed OpenAPI). */
type SimulationRunStatusWire = {
  run_id: string;
  status: string;
  current_tick: number;
};

function runStatusFromWire(
  raw: SimulationRunStatusWire,
  scenario: string,
): SimulationRunView {
  return {
    id: raw.run_id,
    scenario,
    tick: raw.current_tick,
    hour: hourForTick(raw.current_tick),
    status: raw.status,
  };
}

export async function pauseSimulationRun(
  runId: string,
  scenario: string,
): Promise<SimulationRunView> {
  const raw = await api.post<SimulationRunStatusWire>(
    `/v1/simulation/runs/${encodeURIComponent(runId)}/pause`,
    {},
  );
  return runStatusFromWire(raw, scenario);
}

export async function resumeSimulationRun(
  runId: string,
  scenario: string,
): Promise<SimulationRunView> {
  const raw = await api.post<SimulationRunStatusWire>(
    `/v1/simulation/runs/${encodeURIComponent(runId)}/resume`,
    {},
  );
  return runStatusFromWire(raw, scenario);
}

export type InjectEventType =
  | "price_surge"
  | "storm"
  | "festival"
  | "announcement"
  | "custom";

type InjectSimulationEventResponseWire = {
  run_id: string;
  event_id: string;
  event_type: string;
  title: string;
  queued_for_tick: number;
};

type PatchSimulationAgentResponseWire = {
  run_id: string;
  agent_id: string;
  state: SimAgentState;
};

export async function injectSimulationEvent(
  runId: string,
  eventType: InjectEventType,
  payload: Record<string, unknown> = {},
): Promise<InjectSimulationEventResponseWire> {
  return api.post<InjectSimulationEventResponseWire>(
    `/v1/simulation/runs/${encodeURIComponent(runId)}/inject`,
    { event_type: eventType, payload },
  );
}

export async function patchSimulationAgent(
  runId: string,
  agentId: string,
  changes: { mood?: number; goal?: string; money?: number },
): Promise<SimAgentState> {
  const raw = await api.patch<PatchSimulationAgentResponseWire>(
    `/v1/simulation/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}`,
    changes,
  );
  return raw.state;
}

/** Per-tick macro metrics (BE-25 wire shape — not yet in committed OpenAPI). */
export type SimTickMetrics = {
  tick: number;
  hour: number;
  avg_mood: number;
  trade_count: number;
  trade_total_amount: number;
  positive_relation_ratio: number;
  population_by_region: Record<string, number>;
};

export type SimMetricsResponse = {
  run_id: string;
  metrics: SimTickMetrics[];
};

/** Fetch tick-level metrics time series for charts. */
export async function getSimulationMetrics(
  runId: string,
): Promise<SimMetricsResponse> {
  return api.get<SimMetricsResponse>(
    `/v1/simulation/runs/${encodeURIComponent(runId)}/metrics`,
  );
}
