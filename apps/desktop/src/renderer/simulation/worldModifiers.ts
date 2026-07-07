import type { WorldModifiersWire } from "@agentcore/contract-types";

export const DEFAULT_WORLD_MODIFIERS: WorldModifiersWire = {
  market_price_multiplier: 1,
  storm_active: false,
  festival_active: false,
  square_attraction_boost: 0,
};

export type WorldModifierChip = {
  id: string;
  label: string;
  tone: "neutral" | "warn" | "positive";
};

/** Human-readable chips for the observation panel. */
export function worldModifierChips(
  modifiers: WorldModifiersWire,
): WorldModifierChip[] {
  const chips: WorldModifierChip[] = [];
  if (modifiers.storm_active) {
    chips.push({ id: "storm", label: "暴风雨", tone: "warn" });
  }
  if (modifiers.festival_active) {
    chips.push({ id: "festival", label: "节庆", tone: "positive" });
  }
  if (modifiers.market_price_multiplier > 1.01) {
    chips.push({
      id: "price",
      label: `物价 ×${modifiers.market_price_multiplier.toFixed(1)}`,
      tone: "warn",
    });
  }
  if (modifiers.square_attraction_boost > 0.01) {
    chips.push({
      id: "square",
      label: `广场吸引力 +${Math.round(modifiers.square_attraction_boost * 100)}%`,
      tone: "positive",
    });
  }
  return chips;
}
