import {
  MODEL_TIER_META,
  reasoningMeta,
  useProjectedExecution,
} from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { Brain, Cpu, MessageSquare, Wrench, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { CheckpointBadge } from "./CheckpointBadge";

interface Props {
  nodeId: string;
  onClose: () => void;
}

export function NodeDetail({ nodeId, onClose }: Props) {
  const execution = useProjectedExecution();
  const closeGraph = useUIStore((s) => s.closeGraph);
  if (!execution) return null;

  const step = execution.steps.find((s) => s.id === nodeId);
  const agent = step
    ? execution.agents.find((a) => a.id === step.agentId)
    : null;

  if (!step || !agent) return null;

  const output = agent.outputChunks.join("");

  return (
    <div className="flex w-72 flex-col border-l border-border bg-card">
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <span className="truncate text-sm font-medium text-foreground">
          {agent.role}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={closeGraph}
            title="在对话中查看"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MessageSquare size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Task */}
        <section className="mb-4">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            任务
          </h3>
          <p className="text-sm text-foreground">{step.task}</p>
        </section>

        {/* Status */}
        <section className="mb-4">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            状态
          </h3>
          <StatusBadge status={step.status} />
          {step.durationMs != null && (
            <span className="ml-2 text-xs text-muted-foreground">
              {(step.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </section>

        {/* Model tier + effective reasoning (tier default folded with any
            per-agent override, 提案 B) */}
        <section className="mb-4">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            模型与推理
          </h3>
          <div className="flex items-center gap-1.5">
            <Cpu size={14} className="shrink-0 text-muted-foreground" />
            <span className="text-sm text-foreground">
              {MODEL_TIER_META[agent.modelPreference].label}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Brain size={14} className="shrink-0 text-muted-foreground" />
            <span className="text-sm text-foreground">
              {reasoningMeta(agent.thinking, agent.reasoningEffort).label}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {reasoningMeta(agent.thinking, agent.reasoningEffort).description}
          </p>
        </section>

        {/* Checkpoint decision */}
        {step.checkpoint && (
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              检查点
            </h3>
            <CheckpointBadge checkpoint={step.checkpoint} />
            {step.checkpoint.reason && (
              <p className="mt-1 text-xs text-muted-foreground">
                {step.checkpoint.reason}
              </p>
            )}
          </section>
        )}

        {/* Tool calls — mirrors the task card's per-agent tool rows */}
        {agent.toolCalls.length > 0 && (
          <section className="mb-4">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              工具调用 ({agent.toolCalls.length})
            </h3>
            <div className="space-y-1">
              {agent.toolCalls.map((tc) => (
                <div
                  key={tc.id}
                  className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs"
                >
                  <Wrench
                    size={12}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="flex-1 truncate font-mono text-foreground">
                    {tc.toolName}
                  </span>
                  <span
                    className={
                      tc.status === "error"
                        ? "text-destructive"
                        : tc.status === "running"
                          ? "text-primary"
                          : "text-muted-foreground"
                    }
                  >
                    {tc.status === "running"
                      ? "执行中"
                      : tc.status === "error"
                        ? "失败"
                        : "完成"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Output */}
        {output && (
          <section>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              输出
            </h3>
            <div className="markdown-body rounded-lg bg-muted p-3 text-foreground">
              <ReactMarkdown>{output}</ReactMarkdown>
            </div>
          </section>
        )}

        {/* Summary */}
        {step.outputSummary && (
          <section className="mt-4">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              摘要
            </h3>
            <p className="text-sm text-foreground">{step.outputSummary}</p>
          </section>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-muted text-muted-foreground",
    ready: "bg-muted text-muted-foreground",
    running: "bg-primary/10 text-primary",
    completed: "bg-success/10 text-success",
    failed: "bg-destructive/10 text-destructive",
    cancelled: "bg-muted text-muted-foreground",
  };

  const labels: Record<string, string> = {
    pending: "等待中",
    ready: "就绪",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };

  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs ${styles[status] ?? ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}
