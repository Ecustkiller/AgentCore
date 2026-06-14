import {
  MODEL_TIER_META,
  type ModelTier,
  type ReasoningEffort,
} from "@/stores/execution";
import { Play, Sparkles, Users, Workflow, X } from "lucide-react";

interface PreviewAgent {
  id: string;
  role: string;
  modelPreference: ModelTier;
  reasoningEffort: ReasoningEffort;
  stepCount: number;
}

interface Props {
  agents: PreviewAgent[];
  taskSummary: string;
  onSetTier: (agentId: string, tier: ModelTier) => void;
  onSetDeep: (agentId: string, deep: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
  onShowGraph: () => void;
}

const TIERS: ModelTier[] = ["fast", "strong"];

export function TeamPreviewCard({
  agents,
  taskSummary,
  onSetTier,
  onSetDeep,
  onStart,
  onCancel,
  onShowGraph,
}: Props) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {/* Header */}
      <div className="mb-1 flex items-center gap-2">
        <Users size={16} className="text-primary" />
        <span className="flex-1 text-sm font-medium text-foreground">
          团队预览
        </span>
        <button
          type="button"
          onClick={onShowGraph}
          title="在协作图中查看"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Workflow size={15} />
        </button>
      </div>

      <p className="text-sm text-foreground">{taskSummary}</p>
      <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
        执行前可调整每个成员的模型档位与思考深度，确认后开始执行。
      </p>

      {/* Roster */}
      <div className="space-y-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{agent.role}</p>
              {agent.stepCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {agent.stepCount} 个步骤
                </p>
              )}
            </div>
            <div className="flex shrink-0 rounded-lg border border-border p-0.5">
              {TIERS.map((tier) => {
                const selected = agent.modelPreference === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => onSetTier(agent.id, tier)}
                    title={MODEL_TIER_META[tier].description}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {MODEL_TIER_META[tier].label}
                  </button>
                );
              })}
            </div>
            {/* Deep thinking (max effort): the 提案 B per-agent upgrade. Only
                meaningful on strong — fast is the no-max tier (思考·high), so its
                deep toggle stays disabled; drop from max by switching to fast. */}
            <button
              type="button"
              disabled={agent.modelPreference !== "strong"}
              onClick={() =>
                onSetDeep(agent.id, agent.reasoningEffort !== "max")
              }
              title={
                agent.modelPreference === "strong"
                  ? "深度思考：解锁最高推理强度 (max)，面向极复杂子任务"
                  : "切到强力档后可开启深度思考"
              }
              className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                agent.reasoningEffort === "max"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <Sparkles size={12} />
              深度
            </button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onStart}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90"
        >
          <Play size={14} />
          开始执行
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-destructive hover:bg-destructive/10"
        >
          <X size={14} />
          取消
        </button>
      </div>
    </div>
  );
}
