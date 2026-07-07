import type { SimAgentView } from "@/simulation/store/simulationStore";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { AgentGodModeEditor } from "@/simulation/AgentGodModeEditor";
import {
  TOWN_AGENT_IDS,
  TOWN_AGENT_NAMES,
  type TownAgentId,
} from "@/simulation/town/townRoster";
import { useMemo } from "react";

const TRAIT_LABELS: { key: keyof SimAgentView["bigFive"]; label: string }[] = [
  { key: "openness", label: "开放性" },
  { key: "conscientiousness", label: "尽责性" },
  { key: "extraversion", label: "外向性" },
  { key: "agreeableness", label: "宜人性" },
  { key: "neuroticism", label: "神经质" },
];

function moodLabel(mood: number): string {
  if (mood >= 0.5) return "愉快";
  if (mood >= 0.15) return "平静";
  if (mood >= -0.15) return "一般";
  if (mood >= -0.5) return "低落";
  return "沮丧";
}

function moodTone(mood: number): string {
  if (mood >= 0.15) return "text-success";
  if (mood <= -0.15) return "text-destructive";
  return "text-muted-foreground";
}

function TraitBars({ traits }: { traits: SimAgentView["bigFive"] }) {
  return (
    <dl className="space-y-2">
      {TRAIT_LABELS.map(({ key, label }) => {
        const value = traits[key];
        const pct = Math.round(value * 100);
        return (
          <div key={key}>
            <div className="mb-1 flex justify-between text-xs">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono text-foreground">{pct}%</dd>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </dl>
  );
}

function AgentDetail({ agent }: { agent: SimAgentView }) {
  const relEntries = useMemo(() => {
    return Object.entries(agent.relationships)
      .map(([id, value]) => ({
        id,
        name: TOWN_AGENT_NAMES[id as TownAgentId] ?? id,
        value,
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }, [agent.relationships]);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-base font-medium text-foreground">{agent.name}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{agent.role}</p>
        <p className="mt-2 text-sm text-foreground">{agent.bio}</p>
      </section>

      <section>
        <h4 className="text-xs font-medium text-muted-foreground">性格</h4>
        <div className="mt-2">
          <TraitBars traits={agent.bigFive} />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-background p-3">
        <h4 className="text-xs font-medium text-muted-foreground">当前状态</h4>
        <dl className="mt-2 space-y-1.5 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">目标</dt>
            <dd className="text-right text-foreground">{agent.goal || "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">情绪</dt>
            <dd className={`text-right ${moodTone(agent.mood)}`}>
              {moodLabel(agent.mood)}
              <span className="ml-1 font-mono text-xs text-muted-foreground">
                ({agent.mood.toFixed(2)})
              </span>
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">金钱</dt>
            <dd className="text-right font-mono text-foreground">
              {agent.money.toFixed(0)}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">位置</dt>
            <dd className="text-right text-foreground">{agent.location || "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">活动</dt>
            <dd className="text-right text-foreground">{agent.activity || "—"}</dd>
          </div>
        </dl>
        {agent.lastThought?.trim() ? (
          <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
            {agent.lastThought}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-dashed border-border bg-muted/20 p-3">
        <h4 className="text-xs font-medium text-muted-foreground">上帝模式</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          直接修改居民参数，变更将在下一 tick 前同步到模拟世界。
        </p>
        <div className="mt-3">
          <AgentGodModeEditor agent={agent} />
        </div>
      </section>

      <section>
        <h4 className="text-xs font-medium text-muted-foreground">人际关系</h4>
        {relEntries.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">暂无关系数据。</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {relEntries.map((rel) => (
              <li
                key={rel.id}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span className="text-foreground">{rel.name}</span>
                <span
                  className={
                    rel.value > 0.2
                      ? "text-success"
                      : rel.value < -0.2
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  {rel.value > 0 ? "+" : ""}
                  {rel.value.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ResidentsPanel() {
  const agents = useSimulationUiStore((s) => s.agents);
  const selectedAgentId = useSimulationUiStore((s) => s.selectedAgentId);
  const trackedAgentId = useSimulationUiStore((s) => s.trackedAgentId);
  const setSelectedAgentId = useSimulationUiStore((s) => s.setSelectedAgentId);
  const setTrackedAgentId = useSimulationUiStore((s) => s.setTrackedAgentId);
  const startTracking = useSimulationUiStore((s) => s.startTracking);

  const selected = selectedAgentId ? agents[selectedAgentId] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          点击居民进入跟踪视角，或在 3D 场景中点击 NPC。
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <ul className="max-h-[42%] shrink-0 overflow-y-auto border-b border-border p-2">
          {TOWN_AGENT_IDS.map((id) => {
            const agent = agents[id];
            const active = selectedAgentId === id;
            const tracking = trackedAgentId === id;
            return (
              <li key={id}>
                <div
                  className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1 transition-colors ${
                    active
                      ? "bg-primary/10 ring-1 ring-primary/30"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col rounded-lg px-1 py-1 text-left text-foreground"
                    onClick={() => {
                      if (active && tracking) {
                        setSelectedAgentId(null);
                        setTrackedAgentId(null);
                        return;
                      }
                      startTracking(id);
                    }}
                  >
                    <span className="text-sm font-medium">
                      {agent?.name ?? TOWN_AGENT_NAMES[id]}
                      {tracking ? (
                        <span className="ml-1.5 text-xs font-normal text-primary">
                          · 跟踪中
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {agent?.role ?? "—"}
                      {agent?.location ? ` · ${agent.location}` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
                    onClick={() => startTracking(id)}
                  >
                    跟踪
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {selected ? (
            <AgentDetail agent={selected} />
          ) : (
            <p className="text-sm text-muted-foreground">
              从左侧选择一位居民查看人设与状态。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
