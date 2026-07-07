import { parseJumpTarget } from "@/simulation/jumpTarget";
import { computeRegionStats, moodBand } from "@/simulation/regionStats";
import type { SimAgentView } from "@/simulation/store/simulationStore";
import { describe, expect, it } from "vitest";

describe("parseJumpTarget", () => {
  it("parses plain tick numbers", () => {
    expect(parseJumpTarget("12", 48)).toBe(12);
    expect(parseJumpTarget("0", 48)).toBeNull();
  });

  it("parses day expressions", () => {
    expect(parseJumpTarget("第1天", 48)).toBe(1);
    expect(parseJumpTarget("第2天", 48)).toBe(24);
    expect(parseJumpTarget("3天", 48)).toBe(48);
  });

  it("rejects out-of-range values", () => {
    expect(parseJumpTarget("99", 48)).toBeNull();
    expect(parseJumpTarget("", 48)).toBeNull();
  });
});

describe("computeRegionStats", () => {
  const agent = (location: string, mood: number): SimAgentView => ({
    agentId: "a",
    name: "Test",
    role: "",
    bio: "",
    location,
    activity: "",
    mood,
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
  });

  it("aggregates population and mood by region", () => {
    const stats = computeRegionStats({
      a1: { ...agent("广场", 0.5), agentId: "a1" },
      a2: { ...agent("广场", -0.5), agentId: "a2" },
      a3: { ...agent("市场", 0.1), agentId: "a3" },
    });
    const plaza = stats.find((s) => s.id === "广场");
    expect(plaza?.population).toBe(2);
    expect(plaza?.avgMood).toBe(0);
    expect(moodBand(plaza?.avgMood ?? 0)).toBe("medium");
  });
});
