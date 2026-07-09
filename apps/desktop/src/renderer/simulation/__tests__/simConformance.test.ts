import { getTickSnapshot } from "@/services/simulation/api";
import { dispatchSimulationEvent } from "@/services/sse/handlers/simulation";
import {
  useSimulationNavStore,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";
import type { SSEEvent, WorldModifiersWire } from "@agentcore/contract-types";
import m1Tick from "@agentcore/protocol-conformance/fixtures/simulation-m1-tick.json" with {
  type: "json",
};
import interactionConversation from "@agentcore/protocol-conformance/fixtures/simulation/interaction-conversation.json" with {
  type: "json",
};
import multiAgentTick from "@agentcore/protocol-conformance/fixtures/simulation/multi-agent-tick.json" with {
  type: "json",
};
import tickFrameSnapshot from "@agentcore/protocol-conformance/fixtures/simulation/tick-frame-snapshot.json" with {
  type: "json",
};
import worldEvent from "@agentcore/protocol-conformance/fixtures/simulation/world-event.json" with {
  type: "json",
};
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/simulation/api", () => ({
  getTickSnapshot: vi.fn(),
}));

/** The platform-neutral sim projection every end's fold must agree on: the run clock,
 * per-agent nav targets, the decision feed (newest first), and — when the vector exercises
 * them — world modifiers and active interactions. */
type SimFoldFixture = {
  name: string;
  description?: string;
  events: SSEEvent[];
  projected: {
    run: { tick: number; hour: number };
    navTargets: Record<string, { x: number; y: number; z: number }>;
    decisions: Array<{
      tick: number;
      agentId: string;
      actionType: string;
      location?: string;
      summary?: string;
    }>;
    worldModifiers?: WorldModifiersWire;
    activeInteractions?: Array<{
      id: string;
      kind: string;
      status: string;
      initiatorId: string;
      targetId?: string | null;
    }>;
  };
};

const RUN_ID = "run-conformance";

const FIXTURES: SimFoldFixture[] = [
  m1Tick as unknown as SimFoldFixture,
  multiAgentTick as unknown as SimFoldFixture,
  interactionConversation as unknown as SimFoldFixture,
  worldEvent as unknown as SimFoldFixture,
  tickFrameSnapshot as unknown as SimFoldFixture,
];

/** Flush the microtask + macrotask queue so sim.tick_ended's async snapshot readback
 * (mocked to empty agents) has run before we assert the projection. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function resetStores(): void {
  useSimulationUiStore.getState().resetSession();
  useSimulationUiStore.getState().setRun({
    id: RUN_ID,
    scenario: "town",
    tick: 0,
    hour: 8,
    status: "active",
  });
  useSimulationNavStore.setState({ targets: {} });
}

describe("simulation ST-02 conformance · SSE fold", () => {
  beforeEach(() => {
    vi.mocked(getTickSnapshot).mockImplementation((runId, tick) =>
      Promise.resolve({
        run_id: runId,
        tick_number: tick,
        snapshot: { tick, hour: 0, agents: {}, event_log: [] },
      }),
    );
    resetStores();
  });

  for (const fx of FIXTURES) {
    it(`${fx.name}: dispatch fold matches golden`, async () => {
      for (const event of fx.events) {
        dispatchSimulationEvent(event, { runId: RUN_ID });
      }
      await flushAsync();

      const ui = useSimulationUiStore.getState();
      expect(ui.run?.tick).toBe(fx.projected.run.tick);
      expect(ui.run?.hour).toBe(fx.projected.run.hour);

      expect(useSimulationNavStore.getState().targets).toEqual(
        fx.projected.navTargets,
      );

      expect(ui.decisions).toHaveLength(fx.projected.decisions.length);
      fx.projected.decisions.forEach((decision, index) => {
        expect(ui.decisions[index]).toMatchObject(decision);
      });

      if (fx.projected.worldModifiers) {
        expect(ui.worldModifiers).toEqual(fx.projected.worldModifiers);
      }

      if (fx.projected.activeInteractions) {
        for (const ai of fx.projected.activeInteractions) {
          expect(ui.activeInteractions[ai.id]).toMatchObject({
            kind: ai.kind,
            status: ai.status,
            initiatorId: ai.initiatorId,
            targetId: ai.targetId,
          });
        }
      }
    });
  }
});
