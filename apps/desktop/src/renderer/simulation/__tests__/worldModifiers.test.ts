import { worldModifierChips } from "@/simulation/worldModifiers";
import type { WorldModifiersWire } from "@agentcore/contract-types";
import { describe, expect, it } from "vitest";

describe("worldModifierChips", () => {
  it("returns empty for default modifiers", () => {
    const modifiers: WorldModifiersWire = {
      market_price_multiplier: 1,
      storm_active: false,
      festival_active: false,
      square_attraction_boost: 0,
    };
    expect(worldModifierChips(modifiers)).toEqual([]);
  });

  it("surfaces active world effects", () => {
    const chips = worldModifierChips({
      market_price_multiplier: 1.8,
      storm_active: true,
      festival_active: false,
      square_attraction_boost: 0.5,
    });
    expect(chips.map((c) => c.id)).toEqual(["storm", "price", "square"]);
  });
});
