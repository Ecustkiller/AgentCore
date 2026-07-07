import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { TOWN_AGENT_NAMES } from "@/simulation/town/townRoster";
import type { TownAgentId } from "@/simulation/town/townRoster";

export function DecisionPanel({ embedded = false }: { embedded?: boolean }) {
  const decisions = useSimulationUiStore((s) => s.decisions);
  const run = useSimulationUiStore((s) => s.run);
  const playhead = useSimulationUiStore((s) => s.playhead);
  const playbackMode = useSimulationUiStore((s) => s.playbackMode);
  const tickCache = useSimulationUiStore((s) => s.tickCache);
  const streamStatus = useSimulationUiStore((s) => s.streamStatus);
  const streamError = useSimulationUiStore((s) => s.streamError);

  const viewTick = playhead ?? run?.tick ?? 0;
  const tickDecisions = decisions.filter((d) => d.tick === viewTick);
  const latest = tickDecisions[0];
  const snapshot = viewTick > 0 ? tickCache[viewTick] : undefined;

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {latest ? (
        <article className="rounded-xl border border-border bg-background p-3">
          <div className="text-xs text-muted-foreground">
            Tick {latest.tick} ·{" "}
            {TOWN_AGENT_NAMES[latest.agentId as TownAgentId] ?? latest.agentId}
            {latest.location ? ` · ${latest.location}` : ""}
          </div>
          <p className="mt-2 text-sm text-foreground">{latest.summary}</p>
          <div className="mt-2 text-xs text-muted-foreground">
            行动：{latest.actionType}
          </div>
        </article>
      ) : snapshot && Object.keys(snapshot.agents ?? {}).length > 0 ? (
        <article className="rounded-xl border border-border bg-background p-3">
          <div className="text-xs text-muted-foreground">Tick {viewTick} · 快照</div>
          <ul className="mt-2 space-y-2">
            {Object.values(snapshot.agents ?? {}).map((agent) => (
              <li key={agent.agent_id} className="text-sm text-foreground">
                <span className="text-muted-foreground">{agent.name}</span>
                {agent.last_thought?.trim() ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {agent.last_thought}
                  </p>
                ) : agent.activity ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {agent.activity} · {agent.location}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            完整决策文本见「事件流」Tab。
          </p>
        </article>
      ) : (
        <p className="text-sm text-muted-foreground">
          {viewTick > 0
            ? `Tick ${viewTick} 暂无已缓存的决策摘要。`
            : "推进 tick 后，本面板显示该步的 sim.agent_action 摘要。"}
        </p>
      )}

      {tickDecisions.length > 1 ? (
        <ul className="mt-4 space-y-2">
          {tickDecisions.slice(1, 8).map((d, i) => (
            <li
              key={`${d.tick}-${d.agentId}-${i}`}
              className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
            >
              <span className="text-foreground">T{d.tick}</span> {d.summary}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-border bg-card">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <h2 className="text-base font-medium text-foreground">决策摘要</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {run
            ? `Run ${run.id.slice(0, 8)}… · SSE ${streamStatus}${
                playbackMode === "replay" ? ` · 回放 T${viewTick}` : ""
              }`
            : "尚未创建模拟 Run"}
        </p>
        {streamError ? (
          <p className="mt-1 text-xs text-destructive">{streamError}</p>
        ) : null}
      </header>
      {body}
    </aside>
  );
}
