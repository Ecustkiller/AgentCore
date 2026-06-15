import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  describeFrame,
  execRuntime,
  useActiveExecField,
  useExecutionScope,
  useExecutionStore,
} from "@/stores/execution";
import { Pause, Play, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const STEP_INTERVAL_MS = 450;

/**
 * Timeline scrubber for the collaboration graph.
 *
 * The graph is a projection of an append-only frame stream, so "scrubbing" is
 * just moving the playhead over that stream and re-projecting. Following the
 * tail (`playhead === null`) is live; any earlier index is replay.
 */
export function Timeline({ autoPlay = false }: { autoPlay?: boolean } = {}) {
  // Playback targets this graph's per-message slot (§9.3), so scrubbing one
  // message's graph never moves another's playhead.
  const messageId = useExecutionScope();
  const plan = useActiveExecField((rt) => rt.plan);
  const frames = useActiveExecField((rt) => rt.frames);
  const playhead = useActiveExecField((rt) => rt.playhead);
  const setPlayhead = useExecutionStore((s) => s.setPlayhead);
  const goLive = useExecutionStore((s) => s.goLive);
  const [playing, setPlaying] = useState(false);

  const total = frames.length;
  const pos = playhead ?? total;
  const isLive = playhead === null;

  useEffect(() => {
    if (!playing || !messageId) return;
    const id = setInterval(() => {
      const state = useExecutionStore.getState();
      const rt = execRuntime(state, messageId);
      const count = rt.frames.length;
      const cur = rt.playhead ?? count;
      const next = cur + 1;
      if (next >= count) {
        state.goLive(messageId);
        setPlaying(false);
      } else {
        state.setPlayhead(next, messageId);
      }
    }, STEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [playing, messageId]);

  // Full-screen「回放」entry (autoPlay): rewind to the first frame and start
  // playing once on mount. Guarded so a later manual pause never re-triggers it.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoPlay || autoStartedRef.current || !messageId) return;
    if (frames.length === 0) return;
    autoStartedRef.current = true;
    setPlayhead(0, messageId);
    setPlaying(true);
  }, [autoPlay, messageId, frames.length, setPlayhead]);

  if (!plan || total === 0 || !messageId) return null;

  const currentFrame = pos > 0 ? frames[pos - 1] : null;
  const description = currentFrame
    ? describeFrame(currentFrame, plan)
    : "等待执行开始…";

  const onTogglePlay = () => {
    if (!playing && (playhead === null || pos >= total)) {
      // Restart replay from the beginning when starting from the live tail.
      setPlayhead(0, messageId);
    }
    setPlaying((p) => !p);
  };

  const onScrub = (value: number) => {
    setPlaying(false);
    if (value >= total) goLive(messageId);
    else setPlayhead(value, messageId);
  };

  return (
    <div className="pointer-events-auto w-full max-w-[560px] rounded-xl border border-border bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur">
      <div className="flex items-center gap-3">
        <SimpleTooltip label={playing ? "暂停回放" : "回放"}>
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={playing ? "暂停回放" : "回放"}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
        </SimpleTooltip>

        <input
          type="range"
          min={0}
          max={total}
          value={pos}
          onChange={(e) => onScrub(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />

        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {pos}/{total}
        </span>

        <SimpleTooltip label="回到实时">
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              goLive(messageId);
            }}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs ${
              isLive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <Radio size={13} />
            实时
          </button>
        </SimpleTooltip>
      </div>

      <p className="mt-1.5 truncate text-xs text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
