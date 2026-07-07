import {
  type SimTickFrameResponse,
  getTickSnapshot,
} from "@/services/simulation/api";
import { dispatchSimulationEvent } from "@/services/sse/handlers/simulation";
import {
  resetPlaybackSeekGenerationForTests,
  seekToTick,
} from "@/simulation/playback";
import {
  applyTickSnapshot,
  useSimulationNavStore,
  useSimulationPositionsStore,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/simulation/api", () => ({
  getTickSnapshot: vi.fn(),
}));

const SAMPLE_SNAPSHOT = {
  tick: 1,
  hour: 9,
  agents: {
    lin: {
      agent_id: "lin",
      name: "林小梅",
      role: "面包师",
      location: "市场",
      position: { x: 24, y: 0, z: 0 },
      activity: "赶路",
      mood: 0,
      goal: "",
      money: 100,
      last_thought: "得赶紧去市场。",
    },
  },
  event_log: [],
};

describe("applyTickSnapshot", () => {
  beforeEach(() => {
    useSimulationUiStore.setState({
      playhead: null,
      playbackMode: "live",
      playing: false,
      playbackSpeed: 1,
      tickCache: {},
    });
    useSimulationNavStore.setState({ targets: {} });
    useSimulationPositionsStore.setState({ poses: {} });
  });

  it("snaps poses in replay mode", () => {
    useSimulationUiStore.getState().enterReplay(1);
    applyTickSnapshot(SAMPLE_SNAPSHOT);
    expect(useSimulationNavStore.getState().targets.lin).toEqual({
      x: 24,
      y: 0,
      z: 0,
    });
    expect(useSimulationPositionsStore.getState().poses.lin).toEqual({
      x: 24,
      y: 0,
      z: 0,
      yaw: 0,
    });
  });

  it("updates nav only in live mode", () => {
    applyTickSnapshot(SAMPLE_SNAPSHOT);
    expect(useSimulationNavStore.getState().targets.lin).toEqual({
      x: 24,
      y: 0,
      z: 0,
    });
    expect(useSimulationPositionsStore.getState().poses.lin).toBeUndefined();
  });
});

describe("dispatchSimulationEvent replay gate", () => {
  beforeEach(() => {
    useSimulationUiStore.setState({
      run: {
        id: "run-1",
        scenario: "town",
        tick: 2,
        hour: 10,
        status: "active",
      },
      decisions: [],
      streamStatus: "connected",
      streamError: null,
      ticking: false,
      tickError: null,
      playhead: 1,
      playbackMode: "replay",
      playing: false,
      playbackSpeed: 1,
      tickCache: {},
    });
    useSimulationNavStore.setState({ targets: {} });
  });

  it("ignores sim.agent_state while replaying", () => {
    dispatchSimulationEvent(
      {
        type: "sim.agent_state",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          run_id: "run-1",
          tick: 2,
          state: {
            agent_id: "lin",
            name: "林小梅",
            role: "面包师",
            location: "广场",
            position: { x: 99, y: 0, z: 99 },
            activity: "",
            mood: 0,
            goal: "",
            money: 100,
            last_thought: "",
          },
        },
      },
      { runId: "run-1" },
    );
    expect(useSimulationNavStore.getState().targets.lin).toBeUndefined();
  });

  it("ignores async tick_ended snapshot after user enters replay", async () => {
    useSimulationUiStore.setState({
      playhead: null,
      playbackMode: "live",
      agents: {
        lin: {
          agentId: "lin",
          name: "林小梅",
          role: "面包师",
          bio: "",
          location: "市场",
          activity: "",
          mood: 0,
          goal: "",
          money: 0,
          lastThought: "",
          relationships: {},
          bigFive: {
            openness: 0.5,
            conscientiousness: 0.5,
            extraversion: 0.5,
            agreeableness: 0.5,
            neuroticism: 0.5,
          },
        },
      },
    });

    let resolveSnapshot: (value: SimTickFrameResponse) => void = () => {};
    const pending = new Promise<SimTickFrameResponse>((resolve) => {
      resolveSnapshot = resolve;
    });
    vi.mocked(getTickSnapshot).mockReturnValueOnce(pending);

    dispatchSimulationEvent(
      {
        type: "sim.tick_ended",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          run_id: "run-1",
          tick: 2,
          hour: 10,
          agent_count: 1,
        },
      },
      { runId: "run-1" },
    );

    useSimulationUiStore.getState().enterReplay(1);
    applyTickSnapshot(SAMPLE_SNAPSHOT);

    resolveSnapshot({
      run_id: "run-1",
      tick_number: 2,
      snapshot: {
        tick: 2,
        hour: 10,
        agents: {
          lin: {
            agent_id: "lin",
            name: "林小梅",
            role: "面包师",
            location: "广场",
            position: { x: 99, y: 0, z: 99 },
            activity: "",
            mood: 0,
            goal: "",
            money: 100,
            last_thought: "",
          },
        },
        event_log: [],
      },
    });

    await pending;

    expect(useSimulationUiStore.getState().agents.lin?.location).toBe("市场");
    expect(useSimulationNavStore.getState().targets.lin).toEqual({
      x: 24,
      y: 0,
      z: 0,
    });
  });
});

describe("seekToTick generation", () => {
  beforeEach(() => {
    resetPlaybackSeekGenerationForTests();
    vi.mocked(getTickSnapshot).mockReset();
    useSimulationUiStore.setState({
      run: {
        id: "run-1",
        scenario: "town",
        tick: 5,
        hour: 12,
        status: "active",
      },
      playhead: null,
      playbackMode: "live",
      playing: false,
      playbackSpeed: 1,
      tickCache: {},
    });
    useSimulationNavStore.setState({ targets: {} });
    useSimulationPositionsStore.setState({ poses: {} });
  });

  it("drops stale seek when a newer seek starts", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(getTickSnapshot)
      .mockReturnValueOnce(first as Promise<SimTickFrameResponse>)
      .mockResolvedValueOnce({
        run_id: "run-1",
        tick_number: 3,
        snapshot: { ...SAMPLE_SNAPSHOT, tick: 3 },
      });

    const slow = seekToTick("run-1", 2);
    const fast = seekToTick("run-1", 3);
    resolveFirst({
      run_id: "run-1",
      tick_number: 2,
      snapshot: {
        ...SAMPLE_SNAPSHOT,
        tick: 2,
        agents: {
          lin: {
            ...SAMPLE_SNAPSHOT.agents!.lin,
            location: "广场",
            position: { x: 0, y: 0, z: 0 },
          },
        },
      },
    });

    await Promise.all([slow, fast]);

    expect(useSimulationUiStore.getState().playhead).toBe(3);
    expect(useSimulationNavStore.getState().targets.lin).toEqual({
      x: 24,
      y: 0,
      z: 0,
    });
  });
});
