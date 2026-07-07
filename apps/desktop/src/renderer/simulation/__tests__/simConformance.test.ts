import { getTickSnapshot } from "@/services/simulation/api";
import { dispatchSimulationEvent } from "@/services/sse/handlers/simulation";
import {
  useSimulationNavStore,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";
import type { SSEEvent } from "@agentcore/contract-types";
import fixture from "@agentcore/protocol-conformance/fixtures/simulation-m1-tick.json" with {
  type: "json",
};
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/simulation/api", () => ({
  getTickSnapshot: vi.fn(),
}));

type SimConformanceFixture = {
  name: string;
  events: SSEEvent[];
  projected: {
    run: { tick: number; hour: number };
    navTargets: Record<string, { x: number; y: number; z: number }>;
    decisions: Array<{
      tick: number;
      agentId: string;
      actionType: string;
      location?: string;
    }>;
  };
};

const FIXTURE = fixture as SimConformanceFixture;
const RUN_ID = "run-conformance";

function foldSimulationEvents(events: SimConformanceFixture["events"]): void {
  for (const event of events) {
    dispatchSimulationEvent(event, { runId: RUN_ID });
  }
}

describe("simulation ST-02 conformance", () => {
  beforeEach(() => {
    vi.mocked(getTickSnapshot).mockResolvedValue({
      run_id: RUN_ID,
      tick_number: FIXTURE.projected.run.tick,
      snapshot: {
        tick: FIXTURE.projected.run.tick,
        hour: FIXTURE.projected.run.hour,
        agents: {},
        event_log: [],
      },
    });

    useSimulationUiStore.setState({
      run: {
        id: RUN_ID,
        scenario: "town",
        tick: 0,
        hour: 8,
        status: "active",
      },
      decisions: [],
      tickEvents: [],
      streamStatus: "connected",
      streamError: null,
      ticking: false,
      tickError: null,
      playhead: null,
      playbackMode: "live",
      playing: false,
      playbackSpeed: 1,
      tickCache: {},
      activeInteractions: {},
    });
    useSimulationNavStore.setState({ targets: {} });
  });

  it(`${FIXTURE.name}: dispatch fold matches golden`, async () => {
    foldSimulationEvents(FIXTURE.events);
    await vi.waitFor(() => {
      expect(getTickSnapshot).toHaveBeenCalled();
    });

    const ui = useSimulationUiStore.getState();
    expect(ui.run?.tick).toBe(FIXTURE.projected.run.tick);
    expect(ui.run?.hour).toBe(FIXTURE.projected.run.hour);

    const nav = useSimulationNavStore.getState().targets;
    for (const [agentId, target] of Object.entries(
      FIXTURE.projected.navTargets,
    )) {
      expect(nav[agentId]).toEqual(target);
    }

    const lead = FIXTURE.projected.decisions[0];
    expect(ui.decisions[0]).toMatchObject({
      tick: lead.tick,
      agentId: lead.agentId,
      actionType: lead.actionType,
      location: lead.location,
    });
  });
});
