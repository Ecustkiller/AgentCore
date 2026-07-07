import {
  type SimAgentView,
  type SimStreamEvent,
  agentsAtViewTick,
  tickEventsAtView,
} from "@/simulation/store/simulationStore";
import { describe, expect, it } from "vitest";

describe("tickEventsAtView", () => {
  const events: SimStreamEvent[] = [
    { id: "a", tick: 1, type: "sim.tick_started", summary: "t1" },
    { id: "b", tick: 2, type: "sim.tick_started", summary: "t2" },
    { id: "c", tick: 3, type: "sim.tick_started", summary: "t3" },
  ];

  it("caps events at playhead during replay", () => {
    expect(tickEventsAtView(events, 2, true)).toHaveLength(2);
    expect(tickEventsAtView(events, 2, true).every((e) => e.tick <= 2)).toBe(
      true,
    );
  });

  it("returns all events in live mode", () => {
    expect(tickEventsAtView(events, 2, false)).toHaveLength(3);
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
