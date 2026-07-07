const TICKS_PER_DAY = 24;
export const MIN_PLAYBACK_TICK = 1;

/** Parse tick jump input — plain tick number or "第 N 天". */
export function parseJumpTarget(input: string, maxTick: number): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const dayMatch = trimmed.match(/^第?\s*(\d+)\s*天$/);
  if (dayMatch) {
    const day = Number(dayMatch[1]);
    if (Number.isFinite(day) && day >= 1) {
      const tick = (day - 1) * TICKS_PER_DAY;
      return Math.min(Math.max(tick, MIN_PLAYBACK_TICK), maxTick);
    }
    return null;
  }

  const n = Number.parseInt(trimmed, 10);
  if (Number.isFinite(n) && n >= MIN_PLAYBACK_TICK && n <= maxTick) return n;
  return null;
}

export const TICKS_PER_SIM_DAY = TICKS_PER_DAY;
