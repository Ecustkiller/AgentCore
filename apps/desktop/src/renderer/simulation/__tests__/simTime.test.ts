import { describe, expect, it } from "vitest";
import { dayNightPaletteForHour } from "../dayNight";
import { formatSimClock, simClockFromTick } from "../simTime";

describe("simTime", () => {
  it("maps tick to day and hour", () => {
    expect(simClockFromTick(0)).toEqual({ tick: 0, day: 1, hour: 0 });
    expect(simClockFromTick(23)).toEqual({ tick: 23, day: 1, hour: 23 });
    expect(simClockFromTick(24)).toEqual({ tick: 24, day: 2, hour: 0 });
    expect(formatSimClock(25)).toBe("第 2 天 · 1:00");
  });
});

describe("dayNightPaletteForHour", () => {
  it("returns brighter sun at noon than midnight", () => {
    const noon = dayNightPaletteForHour(12);
    const midnight = dayNightPaletteForHour(0);
    expect(noon.sunIntensity).toBeGreaterThan(midnight.sunIntensity);
    expect(noon.ambientIntensity).toBeGreaterThan(midnight.ambientIntensity);
  });
});
