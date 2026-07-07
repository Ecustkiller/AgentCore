import { Button } from "@/components/ui";
import { describeError } from "@/lib/errors";
import {
  advanceSimulationTick,
  pauseSimulationRun,
  resumeSimulationRun,
} from "@/services/simulation/api";
import { updateSavedRun } from "@/simulation/runHistory";
import { SimulationPlaybackControls } from "@/simulation/SimulationPlaybackControls";
import { formatSimClock } from "@/simulation/simTime";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { useState } from "react";

export function TickControlBar() {
  const run = useSimulationUiStore((s) => s.run);
  const ticking = useSimulationUiStore((s) => s.ticking);
  const tickError = useSimulationUiStore((s) => s.tickError);
  const streamStatus = useSimulationUiStore((s) => s.streamStatus);
  const playbackMode = useSimulationUiStore((s) => s.playbackMode);
  const replayActive = useSimulationUiStore(
    (s) => s.playbackMode === "replay" || s.playhead !== null,
  );
  const [statusAction, setStatusAction] = useState<"pause" | "resume" | null>(
    null,
  );
  const [statusError, setStatusError] = useState<string | null>(null);

  const isPaused = run?.status === "paused";
  const canAdvance =
    run?.id &&
    !ticking &&
    streamStatus !== "connecting" &&
    !replayActive &&
    !isPaused &&
    run.status !== "completed";

  const onAdvance = async () => {
    if (!canAdvance) return;
    const store = useSimulationUiStore.getState();
    store.setTicking(true);
    store.setTickError(null);
    try {
      const res = await advanceSimulationTick(run.id);
      store.patchRun({ tick: res.tick, hour: res.hour });
      updateSavedRun(run.id, { tick: res.tick, hour: res.hour });
    } catch (err) {
      store.setTicking(false);
      store.setTickError(describeError(err)?.message ?? "推进 tick 失败");
    }
  };

  const onPause = async () => {
    if (!run?.id || statusAction || isPaused) return;
    setStatusAction("pause");
    setStatusError(null);
    const store = useSimulationUiStore.getState();
    try {
      const updated = await pauseSimulationRun(run.id, run.scenario);
      store.patchRun({
        status: updated.status,
        tick: updated.tick,
        hour: updated.hour,
      });
      updateSavedRun(run.id, {
        status: updated.status,
        tick: updated.tick,
        hour: updated.hour,
      });
    } catch (err) {
      setStatusError(describeError(err)?.message ?? "暂停失败");
    } finally {
      setStatusAction(null);
    }
  };

  const onResume = async () => {
    if (!run?.id || statusAction || !isPaused) return;
    setStatusAction("resume");
    setStatusError(null);
    const store = useSimulationUiStore.getState();
    try {
      const updated = await resumeSimulationRun(run.id, run.scenario);
      store.patchRun({
        status: updated.status,
        tick: updated.tick,
        hour: updated.hour,
      });
      updateSavedRun(run.id, {
        status: updated.status,
        tick: updated.tick,
        hour: updated.hour,
      });
    } catch (err) {
      setStatusError(describeError(err)?.message ?? "恢复失败");
    } finally {
      setStatusAction(null);
    }
  };

  const hourLabel = run != null ? formatSimClock(run.tick) : "—";

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2">
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/80 px-3 py-2 shadow-sm backdrop-blur-sm">
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-r border-border pr-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!canAdvance}
            onClick={() => void onAdvance()}
          >
            {ticking ? "推进中…" : "推进 1 tick"}
          </Button>
          {run?.status === "running" || run?.status === "created" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!run?.id || statusAction !== null || replayActive}
              onClick={() => void onPause()}
            >
              {statusAction === "pause" ? "暂停中…" : "暂停"}
            </Button>
          ) : null}
          {isPaused ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!run?.id || statusAction !== null || replayActive}
              onClick={() => void onResume()}
            >
              {statusAction === "resume" ? "恢复中…" : "恢复"}
            </Button>
          ) : null}
        </div>

        <SimulationPlaybackControls compact />

        <div className="flex shrink-0 items-center gap-2 border-l border-border pl-2 text-xs text-muted-foreground">
          <span className="font-mono text-sm text-foreground">
            T{run?.tick ?? "—"}
          </span>
          <span className="hidden sm:inline">{hourLabel}</span>
          {replayActive && playbackMode === "replay" ? (
            <span className="text-warning">回放</span>
          ) : isPaused ? (
            <span className="text-warning">已暂停</span>
          ) : null}
          {streamStatus !== "connected" && run?.id ? (
            <span>SSE {streamStatus}</span>
          ) : null}
          {tickError ? (
            <span className="text-destructive">{tickError}</span>
          ) : null}
          {statusError ? (
            <span className="text-destructive">{statusError}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
