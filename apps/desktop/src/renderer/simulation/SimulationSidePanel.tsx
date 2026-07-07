import { useState } from "react";
import { DecisionPanel } from "./DecisionPanel";
import { EventTimelinePanel } from "./EventTimelinePanel";
import { GodModePanel } from "./GodModePanel";
import { ObservationPanel } from "./ObservationPanel";
import { ResidentsPanel } from "./ResidentsPanel";
import { SimulationJumpControls } from "./SimulationPlaybackControls";
import { useSimulationUiStore } from "./store/simulationStore";
import { formatSimClock } from "./simTime";

type SideTab = "observe" | "decisions" | "events" | "residents" | "god";

export function SimulationSidePanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SideTab>("decisions");
  const run = useSimulationUiStore((s) => s.run);
  const streamStatus = useSimulationUiStore((s) => s.streamStatus);
  const streamError = useSimulationUiStore((s) => s.streamError);
  const playbackMode = useSimulationUiStore((s) => s.playbackMode);
  const playhead = useSimulationUiStore((s) => s.playhead);
  const viewTick = playhead ?? run?.tick ?? 0;

  return (
    <>
      {open ? (
        <button
          type="button"
          className="absolute inset-0 z-10 bg-background/20"
          aria-label="关闭观测面板"
          onClick={onClose}
        />
      ) : null}

      <aside
        className={`absolute right-0 top-0 z-20 flex h-full w-[400px] max-w-[calc(100vw-1.5rem)] flex-col border-l border-border bg-card/85 shadow-lg backdrop-blur-md transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full pointer-events-none"
        }`}
        aria-hidden={!open}
      >
        <header className="shrink-0 border-b border-border px-4 py-3">
          <h2 className="text-base font-medium text-foreground">观测面板</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {run
              ? `Run ${run.id.slice(0, 8)}… · ${formatSimClock(viewTick)} · SSE ${streamStatus}${
                  playbackMode === "replay" ? ` · 回放 T${viewTick}` : ""
                }`
              : "尚未创建模拟 Run"}
          </p>
          {streamError ? (
            <p className="mt-1 text-xs text-destructive">{streamError}</p>
          ) : null}

          <div className="mt-2">
            <SimulationJumpControls />
          </div>

          <div
            className="mt-3 flex flex-wrap gap-1 rounded-xl border border-border bg-muted/30 p-1"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "observe"}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                tab === "observe"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab("observe")}
            >
              观察
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "decisions"}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                tab === "decisions"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab("decisions")}
            >
              决策摘要
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "events"}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                tab === "events"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab("events")}
            >
              事件流
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "residents"}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                tab === "residents"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab("residents")}
            >
              居民
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "god"}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                tab === "god"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab("god")}
            >
              上帝模式
            </button>
          </div>
        </header>

        {tab === "observe" ? (
          <ObservationPanel />
        ) : tab === "decisions" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DecisionPanel embedded />
          </div>
        ) : tab === "events" ? (
          <EventTimelinePanel />
        ) : tab === "residents" ? (
          <ResidentsPanel />
        ) : (
          <GodModePanel />
        )}
      </aside>
    </>
  );
}
