import { TICKS_PER_SIM_DAY } from "./jumpTarget";

type SimulationTimelineProps = {
  min: number;
  max: number;
  value: number;
  onChange: (tick: number) => void;
  disabled?: boolean;
};

/** Scrubber with day-boundary markers (every 24 ticks). */
export function SimulationTimeline({
  min,
  max,
  value,
  onChange,
  disabled = false,
}: SimulationTimelineProps) {
  const span = Math.max(max - min, 1);
  const dayCount = Math.floor(max / TICKS_PER_SIM_DAY) + 1;
  const dayMarkers = Array.from({ length: dayCount }, (_, i) => i * TICKS_PER_SIM_DAY).filter(
    (t) => t >= min && t <= max,
  );

  return (
    <div className="relative min-w-0 flex-1 px-1">
      <div
        className="pointer-events-none absolute inset-x-1 top-1/2 h-3 -translate-y-1/2"
        aria-hidden
      >
        {dayMarkers.map((tick) => {
          const pct = ((tick - min) / span) * 100;
          const day = Math.floor(tick / TICKS_PER_SIM_DAY) + 1;
          return (
            <div
              key={tick}
              className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${pct}%` }}
            >
              <div className="h-3 w-px bg-border/80" />
              {tick > min ? (
                <span className="mt-0.5 font-mono text-xs text-muted-foreground/70">
                  D{day}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="relative z-10 h-1 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="时间轴"
      />
    </div>
  );
}

export function timelinePositionLabel(tick: number, max: number): string {
  const day = Math.floor(tick / TICKS_PER_SIM_DAY) + 1;
  const hour = tick % TICKS_PER_SIM_DAY;
  return `T${tick}/${max} · 第${day}天 ${hour}:00`;
}
