import { dayNightPaletteForHour } from "@/simulation/dayNight";
import { applyWorldModifierPalette } from "@/simulation/worldModifierPalette";
import { describe, expect, it } from "vitest";

describe("applyWorldModifierPalette", () => {
  const base = dayNightPaletteForHour(10);

  it("returns base palette when no modifiers are active", () => {
    expect(
      applyWorldModifierPalette(base, {
        market_price_multiplier: 1,
        storm_active: false,
        festival_active: false,
        square_attraction_boost: 0,
      }),
    ).toEqual(base);
  });

  it("darkens lighting during storms", () => {
    const storm = applyWorldModifierPalette(base, {
      market_price_multiplier: 1,
      storm_active: true,
      festival_active: false,
      square_attraction_boost: 0,
    });
    expect(storm.sunIntensity).toBeLessThan(base.sunIntensity);
    expect(storm.background).not.toBe(base.background);
  });

  it("warms lighting during festivals", () => {
    const festival = applyWorldModifierPalette(base, {
      market_price_multiplier: 1,
      storm_active: false,
      festival_active: true,
      square_attraction_boost: 0,
    });
    expect(festival.sunIntensity).toBeGreaterThan(base.sunIntensity);
  });
});
