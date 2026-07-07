import { IconButton } from "@/components/ui";
import { disconnectSimulationStream } from "@/services/simulation/stream";
import { SimulationRunManager } from "@/simulation/SimulationRunManager";
import { SimulationSidePanel } from "@/simulation/SimulationSidePanel";
import { TickControlBar } from "@/simulation/TickControlBar";
import { isTownPreviewMode, seedTownPreview } from "@/simulation/previewSeed";
import { formatSimClock } from "@/simulation/simTime";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { TownCanvas } from "@/simulation/town/TownCanvas";
import {
  TOWN_AGENT_NAMES,
  type TownAgentId,
} from "@/simulation/town/townRoster";
import { ArrowLeft, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

/**
 * M1 town simulation — fullscreen immersive 3D canvas with floating overlays.
 */
export function TownSimulationPage() {
  const location = useLocation();
  const run = useSimulationUiStore((s) => s.run);
  const trackedAgentId = useSimulationUiStore((s) => s.trackedAgentId);
  const agents = useSimulationUiStore((s) => s.agents);
  const setTrackedAgentId = useSimulationUiStore((s) => s.setTrackedAgentId);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  const trackedName = trackedAgentId
    ? (agents[trackedAgentId]?.name ??
      TOWN_AGENT_NAMES[trackedAgentId as TownAgentId] ??
      trackedAgentId)
    : null;

  useEffect(() => {
    if (!isTownPreviewMode(location.search)) return;
    seedTownPreview();
  }, [location.search]);

  useEffect(() => {
    return () => {
      disconnectSimulationStream();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sidePanelOpen) {
        setSidePanelOpen(false);
        return;
      }
      if (trackedAgentId) {
        setTrackedAgentId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidePanelOpen, trackedAgentId, setTrackedAgentId]);

  const tickLabel = run
    ? `${formatSimClock(run.tick)} · Kenney 场景 · Mixamo 角色`
    : "手动推进 tick · Kenney 场景 · Mixamo 角色";

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-background">
      <div className="pointer-events-none absolute left-3 top-3 z-30 max-w-[calc(100%-1.5rem)]">
        <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/80 px-3 py-2 shadow-sm backdrop-blur-sm">
          <Link
            to="/"
            className="flex shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="返回首页"
            title="返回首页"
          >
            <ArrowLeft size={18} />
          </Link>

          <div className="min-w-0">
            <h1 className="text-sm font-medium text-foreground">AI 小镇</h1>
            <p className="text-xs text-muted-foreground">{tickLabel}</p>
          </div>

          {run ? (
            <>
              <IconButton
                onClick={() => setSidePanelOpen((open) => !open)}
                aria-label={sidePanelOpen ? "收起观测面板" : "展开观测面板"}
                title={sidePanelOpen ? "收起观测面板" : "展开观测面板"}
              >
                {sidePanelOpen ? (
                  <PanelRightClose size={18} />
                ) : (
                  <PanelRightOpen size={18} />
                )}
              </IconButton>
              <SimulationRunManager />
            </>
          ) : null}
        </div>
      </div>

      {run ? (
        <>
          <TownCanvas />

          {trackedAgentId ? (
            <div className="pointer-events-none absolute left-3 top-20 z-20 flex items-center gap-2">
              <div className="rounded-xl border border-border bg-card/80 px-3 py-2 text-sm text-foreground shadow-sm backdrop-blur-sm">
                跟踪中：<span className="font-medium">{trackedName}</span>
              </div>
              <button
                type="button"
                className="pointer-events-auto rounded-xl border border-border bg-card/80 px-3 py-2 text-sm text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted"
                onClick={() => setTrackedAgentId(null)}
              >
                退出跟踪
              </button>
            </div>
          ) : null}

          <TickControlBar />
          <SimulationSidePanel
            open={sidePanelOpen}
            onClose={() => setSidePanelOpen(false)}
          />
        </>
      ) : (
        <div className="flex h-full min-h-0 items-center justify-center px-6 pt-16">
          <SimulationRunManager />
        </div>
      )}
    </div>
  );
}
