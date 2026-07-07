import { Button, IconButton } from "@/components/ui";
import { describeError } from "@/lib/errors";
import {
  SimulationTimeline,
  timelinePositionLabel,
} from "@/simulation/SimulationTimeline";
import { MIN_PLAYBACK_TICK, parseJumpTarget } from "@/simulation/jumpTarget";
import {
  describeTickSnapshot,
  goLivePlayback,
  seekToTick,
  stepPlaybackTick,
} from "@/simulation/playback";
import { hourForTick } from "@/simulation/runModel";
import {
  type PlaybackSpeed,
  useSimulationUiStore,
} from "@/simulation/store/simulationStore";
import { ChevronLeft, ChevronRight, Pause, Play, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const BASE_STEP_MS = 600;
const SPEEDS: PlaybackSpeed[] = [0.5, 1, 2, 4];

function liveRunTail(): number {
  return useSimulationUiStore.getState().run?.tick ?? 0;
}

export function SimulationJumpControls() {
  const run = useSimulationUiStore((s) => s.run);
  const setPlaying = useSimulationUiStore((s) => s.setPlaying);
  const [seekError, setSeekError] = useState<string | null>(null);
  const [jumpInput, setJumpInput] = useState("");

  if (!run?.id) return null;

  const total = run.tick ?? 0;

  const runSeek = (target: number) => {
    setSeekError(null);
    setPlaying(false);
    if (target >= total) {
      void goLivePlayback(run.id, liveRunTail());
      return;
    }
    void seekToTick(run.id, target).catch((err) => {
      setSeekError(describeError(err)?.message ?? "加载 tick 失败");
    });
  };

  const onJump = () => {
    const target = parseJumpTarget(jumpInput, total);
    if (target === null) {
      setSeekError(
        `请输入 ${MIN_PLAYBACK_TICK}–${total} 的 tick 或「第 N 天」`,
      );
      return;
    }
    setJumpInput("");
    runSeek(target);
  };

  const onJumpDayOne = () => runSeek(MIN_PLAYBACK_TICK);
  const onJumpLatest = () => void goLivePlayback(run.id, liveRunTail());

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="text"
        value={jumpInput}
        onChange={(e) => setJumpInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onJump();
        }}
        placeholder="tick / 第N天"
        className="w-24 rounded-lg border border-border bg-background px-1.5 py-1 text-center font-mono text-xs text-foreground"
        aria-label="跳转到 tick 或天数"
      />
      <Button variant="ghost" size="sm" onClick={onJump}>
        跳转
      </Button>
      <Button variant="ghost" size="sm" onClick={onJumpDayOne}>
        第一天
      </Button>
      <Button variant="ghost" size="sm" onClick={onJumpLatest}>
        最新
      </Button>
      {seekError ? (
        <span className="text-xs text-destructive">{seekError}</span>
      ) : null}
    </div>
  );
}

export function SimulationPlaybackControls({
  compact = false,
}: {
  compact?: boolean;
}) {
  const run = useSimulationUiStore((s) => s.run);
  const playhead = useSimulationUiStore((s) => s.playhead);
  const playing = useSimulationUiStore((s) => s.playing);
  const speed = useSimulationUiStore((s) => s.playbackSpeed);
  const playbackMode = useSimulationUiStore((s) => s.playbackMode);
  const tickCache = useSimulationUiStore((s) => s.tickCache);
  const setPlaying = useSimulationUiStore((s) => s.setPlaying);
  const setPlaybackSpeed = useSimulationUiStore((s) => s.setPlaybackSpeed);

  const [seekError, setSeekError] = useState<string | null>(null);
  const [jumpInput, setJumpInput] = useState("");
  const seekingRef = useRef(false);

  const total = run?.tick ?? 0;
  const hasHistory = total >= MIN_PLAYBACK_TICK;
  const isLive = playhead === null && playbackMode === "live";
  const pos = playhead ?? total;

  const cachedSnapshot =
    playhead != null ? tickCache[playhead] : (tickCache[total] ?? null);
  const description = describeTickSnapshot(cachedSnapshot);

  useEffect(() => {
    if (!playing || !run?.id || total < 1) return;

    const intervalMs = BASE_STEP_MS / speed;
    const id = setInterval(() => {
      if (seekingRef.current) return;
      const state = useSimulationUiStore.getState();
      const tail = state.run?.tick ?? 0;
      const cur = state.playhead ?? tail;
      const next = cur + 1;
      if (next > tail) {
        state.setPlaying(false);
        void goLivePlayback(run.id, tail);
        return;
      }
      seekingRef.current = true;
      void seekToTick(run.id, next)
        .catch((err) => {
          setSeekError(describeError(err)?.message ?? "加载 tick 失败");
          state.setPlaying(false);
        })
        .finally(() => {
          seekingRef.current = false;
        });
    }, intervalMs);

    return () => clearInterval(id);
  }, [playing, run?.id, speed, total]);

  if (!run?.id) return null;

  const runSeek = (target: number) => {
    setSeekError(null);
    setPlaying(false);
    if (target >= total) {
      void goLivePlayback(run.id, liveRunTail());
      return;
    }
    void seekToTick(run.id, target).catch((err) => {
      setSeekError(describeError(err)?.message ?? "加载 tick 失败");
    });
  };

  const onTogglePlay = () => {
    setSeekError(null);
    if (!playing && (playhead === null || pos >= total)) {
      void seekToTick(run.id, MIN_PLAYBACK_TICK)
        .then(() => setPlaying(true))
        .catch((err) => {
          setSeekError(describeError(err)?.message ?? "加载 tick 失败");
        });
      return;
    }
    setPlaying(!playing);
  };

  const onStep = (delta: -1 | 1) => {
    setSeekError(null);
    setPlaying(false);
    void stepPlaybackTick(run.id, delta).catch((err) => {
      setSeekError(describeError(err)?.message ?? "加载 tick 失败");
    });
  };

  const onGoLive = () => {
    setSeekError(null);
    const tail = useSimulationUiStore.getState().run?.tick ?? total;
    void goLivePlayback(run.id, tail);
  };

  const onJump = () => {
    const target = parseJumpTarget(jumpInput, total);
    if (target === null) {
      setSeekError(
        `请输入 ${MIN_PLAYBACK_TICK}–${total} 的 tick 或「第 N 天」`,
      );
      return;
    }
    setJumpInput("");
    runSeek(target);
  };

  const onJumpDayOne = () => runSeek(MIN_PLAYBACK_TICK);

  const displayHour =
    cachedSnapshot?.hour ??
    (pos >= 0 ? hourForTick(pos) : hourForTick(run.tick));

  return (
    <div
      className={
        compact
          ? "flex min-w-0 items-center gap-1.5"
          : "flex min-w-0 flex-1 flex-col gap-1.5"
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            onClick={() => onStep(-1)}
            disabled={pos <= MIN_PLAYBACK_TICK || seekingRef.current}
            aria-label="后退一 tick"
            title="后退一 tick"
          >
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton
            onClick={onTogglePlay}
            disabled={total < 1}
            aria-label={playing ? "暂停回放" : "播放回放"}
            title={playing ? "暂停回放" : "播放回放"}
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </IconButton>
          <IconButton
            onClick={() => onStep(1)}
            disabled={pos >= total || seekingRef.current}
            aria-label="前进一 tick"
            title="前进一 tick"
          >
            <ChevronRight size={16} />
          </IconButton>
        </div>

        {hasHistory ? (
          <SimulationTimeline
            min={MIN_PLAYBACK_TICK}
            max={Math.max(total, MIN_PLAYBACK_TICK)}
            value={Math.max(pos, MIN_PLAYBACK_TICK)}
            onChange={runSeek}
          />
        ) : null}

        <span className="hidden shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:inline">
          {timelinePositionLabel(pos, total)}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {SPEEDS.map((s) => (
            <Button
              key={s}
              variant="ghost"
              size="sm"
              onClick={() => setPlaybackSpeed(s)}
              className={
                speed === s
                  ? "min-w-0 px-1.5 bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary"
                  : "min-w-0 px-1.5"
              }
            >
              {s}x
            </Button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onGoLive}
          icon={<Radio size={13} />}
          className={
            isLive
              ? "shrink-0 bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary"
              : "shrink-0"
          }
        >
          最新
        </Button>

        {!compact ? (
          <div className="flex shrink-0 items-center gap-1">
            <input
              type="text"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onJump();
              }}
              placeholder="tick / 第N天"
              className="w-20 rounded-lg border border-border bg-background px-1.5 py-1 text-center font-mono text-xs text-foreground"
              aria-label="跳转到 tick 或天数"
            />
            <Button variant="ghost" size="sm" onClick={onJump}>
              跳转
            </Button>
            <Button variant="ghost" size="sm" onClick={onJumpDayOne}>
              第一天
            </Button>
          </div>
        ) : null}
      </div>

      {!compact ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          {playbackMode === "replay" ? (
            <span className="shrink-0 rounded-lg bg-warning/15 px-2 py-0.5 font-medium text-warning-foreground">
              回放模式
            </span>
          ) : (
            <span className="shrink-0 rounded-lg bg-primary/10 px-2 py-0.5 font-medium text-primary">
              实时模式
            </span>
          )}
          <span className="min-w-0 truncate text-muted-foreground">
            {description}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
            {displayHour}:00
          </span>
          {seekError ? (
            <span className="shrink-0 text-destructive">{seekError}</span>
          ) : null}
        </div>
      ) : seekError ? (
        <span className="shrink-0 text-xs text-destructive">{seekError}</span>
      ) : null}
    </div>
  );
}
