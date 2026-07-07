import { dispatchSimulationEvent } from "@/services/sse/handlers/simulation";
import {
  useSimulationNavStore,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";
import {
  seedAgentSpawnIfNeeded,
  spawnPositionForAgent,
} from "@/simulation/town/agentSpawn";
import { beforeEach, describe, expect, it } from "vitest";

describe("agentSpawn", () => {
  beforeEach(() => {
    useSimulationNavStore.setState({ targets: {} });
  });

  it("seeds home target when none exists", () => {
    const start = seedAgentSpawnIfNeeded("liu", "广场");
    expect(start).toEqual({ x: 0, y: 0, z: 0 });
    expect(useSimulationNavStore.getState().targets.liu).toEqual(start);
  });

  it("does not clobber SSE nav target on late mount", () => {
    useSimulationNavStore.getState().setTarget("liu", { x: 24, y: 0, z: 0 });
    seedAgentSpawnIfNeeded("liu", "广场");
    expect(useSimulationNavStore.getState().targets.liu).toEqual({
      x: 24,
      y: 0,
      z: 0,
    });
    expect(spawnPositionForAgent("liu", "广场")).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe("dispatchSimulationEvent + spawn", () => {
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
    });
    useSimulationNavStore.setState({ targets: {} });
  });

  it("keeps liu market target after sim.agent_state then late spawn init", () => {
    dispatchSimulationEvent(
      {
        type: "sim.agent_state",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          run_id: "run-1",
          tick: 1,
          state: {
            agent_id: "liu",
            name: "刘警官",
            role: "镇派出所民警",
            location: "市场",
            position: { x: 24, y: 0, z: 0 },
            activity: "巡逻",
            mood: 0,
            goal: "",
            last_thought: "",
          },
        },
      },
      { runId: "run-1" },
    );
    seedAgentSpawnIfNeeded("liu", "广场");
    expect(useSimulationNavStore.getState().targets.liu).toEqual({
      x: 24,
      y: 0,
      z: 0,
    });
  });
});
