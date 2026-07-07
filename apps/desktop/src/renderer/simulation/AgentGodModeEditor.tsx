import { notifyError, notifySuccess } from "@/lib/toast";
import { patchSimulationAgent } from "@/services/simulation/api";
import type { SimAgentView } from "@/simulation/store/simulationStore";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type AgentGodModeEditorProps = {
  agent: SimAgentView;
};

export function AgentGodModeEditor({ agent }: AgentGodModeEditorProps) {
  const run = useSimulationUiStore((s) => s.run);
  const upsertAgentState = useSimulationUiStore((s) => s.upsertAgentState);

  const [mood, setMood] = useState(agent.mood);
  const [goal, setGoal] = useState(agent.goal);
  const [money, setMoney] = useState(agent.money);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    setMood(agent.mood);
    setGoal(agent.goal);
    setMoney(agent.money);
  }, [agent.agentId, agent.mood, agent.goal, agent.money]);

  const dirty = useMemo(() => {
    return mood !== agent.mood || goal !== agent.goal || money !== agent.money;
  }, [agent.goal, agent.money, agent.mood, goal, money, mood]);

  async function handleApply() {
    const runId = run?.id;
    if (!runId || applying || !dirty) return;

    const changes: { mood?: number; goal?: string; money?: number } = {};
    if (mood !== agent.mood) changes.mood = mood;
    if (goal !== agent.goal) changes.goal = goal;
    if (money !== agent.money) changes.money = money;

    setApplying(true);
    try {
      const state = await patchSimulationAgent(runId, agent.agentId, changes);
      upsertAgentState(state);
      notifySuccess(`已更新 ${agent.name} 的参数`);
    } catch (err) {
      notifyError(err, "参数修改失败");
    } finally {
      setApplying(false);
    }
  }

  if (!run?.id) {
    return (
      <p className="text-xs text-muted-foreground">
        创建 Run 后可在此修改居民参数。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">情绪 (mood)</span>
          <span className="font-mono text-foreground">{mood.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={mood}
          onChange={(e) => setMood(Number(e.target.value))}
          className="w-full accent-primary"
        />
        <div className="mt-0.5 flex justify-between text-xs text-muted-foreground">
          <span>-1.0</span>
          <span>1.0</span>
        </div>
      </label>

      <label className="block">
        <span className="text-xs text-muted-foreground">目标 (goal)</span>
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
        />
      </label>

      <label className="block">
        <span className="text-xs text-muted-foreground">金钱 (money)</span>
        <input
          type="number"
          min={0}
          step={1}
          value={money}
          onChange={(e) => setMoney(Number(e.target.value))}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
        />
      </label>

      <button
        type="button"
        disabled={!dirty || applying}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void handleApply()}
      >
        {applying ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : null}
        应用修改
      </button>
      {dirty ? (
        <p className="text-xs text-muted-foreground">
          有未保存的修改，点击「应用修改」后将在下一 tick 前生效。
        </p>
      ) : null}
    </div>
  );
}
