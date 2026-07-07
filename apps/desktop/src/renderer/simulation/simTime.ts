/** Clock derived from tick index — 24 ticks per day, hour 0–23. */

export type SimClock = {
  tick: number;
  day: number;
  hour: number;
};

export function simClockFromTick(tick: number): SimClock {
  const safe = Math.max(0, Math.floor(tick));
  return {
    tick: safe,
    day: Math.floor(safe / 24) + 1,
    hour: safe % 24,
  };
}

export function formatSimClock(tick: number): string {
  const { day, hour } = simClockFromTick(tick);
  return `第 ${day} 天 · ${hour}:00`;
}
