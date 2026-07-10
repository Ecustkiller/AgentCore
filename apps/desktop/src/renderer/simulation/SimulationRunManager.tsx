import { Button } from "@/components/ui";
import { describeError } from "@/lib/errors";
import { createSimulationRun } from "@/services/simulation/api";
import { OpenInAgentTownButton } from "@/simulation/OpenInAgentTownButton";
import {
  type SavedSimulationRun,
  listSavedRuns,
  rememberRun,
} from "@/simulation/runHistory";
import type { runFromWire } from "@/simulation/runModel";
import { runStatusLabel, runStatusTone } from "@/simulation/runStatus";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { useEffect, useState } from "react";

export function SimulationRunManager({
  onRunActive,
}: {
  onRunActive?: () => void;
}) {
  const run = useSimulationUiStore((s) => s.run);
  const [savedRuns, setSavedRuns] = useState<SavedSimulationRun[]>([]);
  const [creating, setCreating] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setSavedRuns(listSavedRuns());
  }, []);

  const activateRun = (
    next: SavedSimulationRun | ReturnType<typeof runFromWire>,
  ) => {
    useSimulationUiStore.getState().setRun(next);
    rememberRun(next);
    setSavedRuns(listSavedRuns());
    onRunActive?.();
  };

  const onCreate = async () => {
    setCreating(true);
    setActionError(null);
    try {
      const created = await createSimulationRun({ scenario: "town" });
      activateRun(created);
    } catch (err) {
      setActionError(describeError(err)?.message ?? "创建小镇失败");
    } finally {
      setCreating(false);
    }
  };

  const onLoad = (saved: SavedSimulationRun) => {
    if (loadingId) return;
    setLoadingId(saved.id);
    setActionError(null);
    try {
      activateRun(saved);
    } catch (err) {
      setActionError(describeError(err)?.message ?? "加载 Run 失败");
    } finally {
      setLoadingId(null);
    }
  };

  if (run) {
    const tone = runStatusTone(run.status);
    const toneClass =
      tone === "success"
        ? "text-success"
        : tone === "warning"
          ? "text-warning"
          : "text-muted-foreground";

    return (
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-xs text-muted-foreground">
          Run{" "}
          <span className="font-mono text-foreground">
            {run.id.slice(0, 8)}…
          </span>
        </div>
        <div className={`text-xs font-medium ${toneClass}`}>
          {runStatusLabel(run.status)}
        </div>
        <OpenInAgentTownButton runId={run.id} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            useSimulationUiStore.getState().resetSession();
          }}
        >
          退出当前 Run
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="max-w-md text-center">
        <h2 className="text-xl font-medium text-foreground">
          欢迎来到 AI 小镇
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          创建新的小镇模拟，或从本机最近记录中加载已有 Run。
        </p>
      </div>

      <Button
        variant="primary"
        size="sm"
        disabled={creating}
        onClick={() => void onCreate()}
      >
        {creating ? "创建中…" : "新建小镇"}
      </Button>

      <OpenInAgentTownButton variant="neutral" />

      {actionError ? (
        <p className="text-sm text-destructive">{actionError}</p>
      ) : null}

      {savedRuns.length > 0 ? (
        <div className="w-full max-w-lg">
          <h3 className="mb-2 text-sm font-medium text-foreground">最近 Run</h3>
          <ul className="space-y-2">
            {savedRuns.map((saved) => (
              <li key={saved.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40"
                  disabled={loadingId === saved.id}
                  onClick={() => onLoad(saved)}
                >
                  <div>
                    <div className="font-mono text-sm text-foreground">
                      {saved.id.slice(0, 8)}…
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {saved.scenario} · Tick {saved.tick} ·{" "}
                      {runStatusLabel(saved.status)}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {loadingId === saved.id ? "加载中…" : "加载"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">暂无已保存的 Run 记录。</p>
      )}
    </div>
  );
}
