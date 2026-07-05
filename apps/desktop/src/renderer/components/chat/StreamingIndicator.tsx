import { useActiveGenerating, useActiveMessages } from "@/stores/conversation";
import { useMessageExecution } from "@/stores/execution";

export function StreamingIndicator() {
  const isGenerating = useActiveGenerating();
  const messages = useActiveMessages();
  const last = messages[messages.length - 1];
  const isStreaming = last?.role === "assistant" && last.isStreaming;
  const executionId = isStreaming ? last.executionId : null;
  const execution = useMessageExecution(isStreaming ? last.id : null);

  if (!isGenerating || !isStreaming) return null;

  let text = "正在回复…";
  if (executionId && execution && execution.status === "running") {
    const runningRun = execution.runs.find((r) => r.status === "running");
    const role = runningRun
      ? execution.agents.find((a) => a.id === runningRun.agentId)?.role
      : null;
    text = role
      ? `${execution.taskSummary} · ${role} 正在工作`
      : execution.taskSummary;
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
      <span className="truncate text-xs text-muted-foreground">{text}</span>
    </div>
  );
}
