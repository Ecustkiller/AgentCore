import {
  type SimAgentView,
  type SimStreamEvent,
  agentsAtViewTick,
  modifiersAtViewTick,
  tickEventsAtView,
} from "@/simulation/store/simulationStore";
import { DEFAULT_WORLD_MODIFIERS } from "@/simulation/worldModifiers";
import { describe, expect, it } from "vitest";

describe("tickEventsAtView", () => {
  const events: SimStreamEvent[] = [
    { id: "a", tick: 1, type: "sim.tick_started", summary: "t1" },
    { id: "b", tick: 2, type: "sim.tick_started", summary: "t2" },
    { id: "c", tick: 3, type: "sim.tick_started", summary: "t3" },
  ];

  it("caps events at playhead during replay", () => {
    expect(tickEventsAtView(events, events, 2, true)).toHaveLength(2);
    expect(
      tickEventsAtView(events, events, 2, true).every((e) => e.tick <= 2),
    ).toBe(true);
  });

  it("prefers replay log over live stream when replaying", () => {
    const replayOnly = [
      { id: "r", tick: 1, type: "sim.tick_started", summary: "replay" },
    ];
    expect(tickEventsAtView(events, replayOnly, 5, true)).toEqual(replayOnly);
  });

  it("returns all events in live mode", () => {
    expect(tickEventsAtView(events, [], 2, false)).toHaveLength(3);
  });
});

describe("agentsAtViewTick", () => {
  const liveAgents: Record<string, SimAgentView> = {
    lin: {
      agentId: "lin",
      name: "林小梅",
      role: "面包师",
      bio: "",
      location: "广场",
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
  };

  it("uses tick cache snapshot during replay", () => {
    const result = agentsAtViewTick(
      1,
      liveAgents,
      {
        1: {
          tick: 1,
          hour: 9,
          agents: {
            lin: {
              agent_id: "lin",
              name: "林小梅",
              role: "面包师",
              location: "市场",
              position: { x: 24, y: 0, z: 0 },
              activity: "",
              mood: 0,
              goal: "",
              money: 100,
              last_thought: "",
            },
          },
          event_log: [],
        },
      },
      true,
    );
    expect(result.lin.location).toBe("市场");
  });
});

describe("modifiersAtViewTick", () => {
  it("reads modifiers from tick cache during replay", () => {
    const replayModifiers = {
      market_price_multiplier: 2,
      storm_active: true,
      festival_active: false,
      square_attraction_boost: 0,
    };
    const result = modifiersAtViewTick(
      DEFAULT_WORLD_MODIFIERS,
      {
        2: {
          tick: 2,
          hour: 10,
          modifiers: replayModifiers,
          agents: {},
          event_log: [],
        },
      },
      2,
      true,
    );
    expect(result).toEqual(replayModifiers);
  });
});
