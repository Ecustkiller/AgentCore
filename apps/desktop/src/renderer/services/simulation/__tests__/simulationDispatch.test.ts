import contract from "@agentcore/protocol-conformance/fixtures/simulation-region-positions.json";
import { describe, expect, it, beforeEach } from "vitest";
import { dispatchSimulationEvent } from "@/services/sse/handlers/simulation";
import { REGION_POSITIONS } from "@/simulation/regionPositions";
import {
  useSimulationNavStore,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";

describe("region position contract", () => {
  it("matches protocol-conformance fixture", () => {
    expect(REGION_POSITIONS).toEqual(contract.regions);
  });
});

describe("dispatchSimulationEvent", () => {
  beforeEach(() => {
    useSimulationUiStore.setState({
      run: {
        id: "run-1",
        scenario: "town",
        tick: 0,
        hour: 8,
        status: "active",
      },
      decisions: [],
      streamStatus: "connected",
      streamError: null,
      ticking: false,
      tickError: null,
      playhead: null,
      playbackMode: "live",
      playing: false,
      playbackSpeed: 1,
      tickCache: {},
      tickEvents: [],
      activeInteractions: {},
    });
    useSimulationNavStore.setState({ targets: {} });
  });

  it("moves NPC via sim.agent_state position (authoritative)", () => {
    dispatchSimulationEvent(
      {
        type: "sim.agent_state",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          run_id: "run-1",
          tick: 1,
          state: {
            agent_id: "lin",
            name: "林小梅",
            role: "面包师",
            location: "市场",
            position: { x: 24, y: 0, z: 0 },
            activity: "赶路",
            mood: 0,
            goal: "",
            last_thought: "",
          },
        },
      },
      { runId: "run-1" },
    );

    const target = useSimulationNavStore.getState().targets.lin;
    expect(target).toEqual({ x: 24, y: 0, z: 0 });
  });

  it("records decision summary from sim.agent_action", () => {
    dispatchSimulationEvent(
      {
        type: "sim.agent_action",
        timestamp: "2026-01-01T00:00:00.001Z",
        payload: {
          run_id: "run-1",
          tick: 1,
          action: {
            agent_id: "lin",
            action: "move_to",
            thought: "得赶紧去市场进原料。",
            tool_name: null,
            tool_args: { destination: "市场", reason: "进面粉" },
            success: true,
            detail: "",
          },
        },
      },
      { runId: "run-1" },
    );

    const decisions = useSimulationUiStore.getState().decisions;
    expect(decisions[0]?.summary).toBe("得赶紧去市场进原料。");
    expect(decisions[0]?.location).toBe("市场");
    expect(decisions[0]?.actionType).toBe("move_to");

    const events = useSimulationUiStore.getState().tickEvents;
    expect(events.some((e) => e.type === "sim.agent_action")).toBe(true);
  });

  it("stores active interaction from sim.interaction", () => {
    dispatchSimulationEvent(
      {
        type: "sim.interaction",
        timestamp: "2026-01-01T00:00:00.002Z",
        payload: {
          run_id: "run-1",
          tick: 2,
          interaction: {
            request_id: "ix-1",
            kind: "conversation",
            status: "completed",
            initiator_id: "lin",
            target_id: "liu",
            summary: "林与刘聊了几句",
            transcript: [
              {
                speaker_id: "lin",
                speaker_name: "林小梅",
                text: "今天面粉涨价了吗？",
                round: 0,
              },
            ],
          },
        },
      },
      { runId: "run-1" },
    );

    const active = useSimulationUiStore.getState().activeInteractions["ix-1"];
    expect(active?.kind).toBe("conversation");
    expect(active?.initiatorId).toBe("lin");

    const events = useSimulationUiStore.getState().tickEvents;
    expect(events[0]?.interaction?.kind).toBe("conversation");
  });
});
