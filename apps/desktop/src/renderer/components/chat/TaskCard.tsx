import {
  type AgentState,
  type ToolCallState,
  useExecutionStore,
  useProjectedExecution,
} from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function TaskCard() {
  const execution = useProjectedExecution();
  const openGraph = useUIStore((s) => s.openGraph);
  const graphOpen = useUIStore((s) => s.graphOpen);
  const focusedAgentId = useExecutionStore((s) => s.focusedAgentId);
  const focusAgent = useExecutionStore((s) => s.focusAgent);
  const pendingReview = useExecutionStore((s) => s.pendingReview);
  const [expanded, setExpanded] = useState(true);

  if (!execution || execution.planType === "single_agent") return null;
  // During the pre-execution gate the TeamPreviewCard owns the roster; avoid
  // stacking two cards showing the same agents.
  if (pendingReview) return null;

  const onShowInGraph = (agentId: string) => {
    focusAgent(agentId);
    openGraph();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown size={14} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={14} className="text-muted-foreground" />
          )}
          <span className="flex-1 text-sm font-medium text-foreground">
            {execution.taskSummary}
          </span>
          <span className="text-xs text-muted-foreground">
            {execution.progress.completed}/{execution.progress.total}
          </span>
        </button>
        <button
          type="button"
          onClick={openGraph}
          title="查看协作图"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Workflow size={15} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{
            width:
              execution.progress.total > 0
                ? `${(execution.progress.completed / execution.progress.total) * 100}%`
                : "0%",
          }}
        />
      </div>

      {/* Agent list (expanded) */}
      {expanded && (
        <div className="mt-3 space-y-2">
          {execution.agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              focused={focusedAgentId === agent.id}
              graphOpen={graphOpen}
              onToggleFocus={() =>
                focusAgent(focusedAgentId === agent.id ? null : agent.id)
              }
              onShowInGraph={() => onShowInGraph(agent.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  focused,
  graphOpen,
  onToggleFocus,
  onShowInGraph,
}: {
  agent: AgentState;
  focused: boolean;
  graphOpen: boolean;
  onToggleFocus: () => void;
  onShowInGraph: () => void;
}) {
  const [showTools, setShowTools] = useState(false);
  const hasTools = agent.toolCalls.length > 0;
  const rowRef = useRef<HTMLDivElement>(null);

  // When a node selected in the graph is mirrored here, bring it into view as
  // the user returns to the conversation.
  useEffect(() => {
    if (focused && !graphOpen) {
      rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focused, graphOpen]);

  return (
    <div
      ref={rowRef}
      className={`rounded-lg transition-colors ${
        focused ? "bg-primary/10 ring-1 ring-primary" : "bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusIndicator status={agent.status} />
        <button
          type="button"
          onClick={onToggleFocus}
          className="flex-1 truncate text-left text-sm text-foreground"
        >
          {agent.role}
        </button>
        {hasTools && (
          <button
            type="button"
            onClick={() => setShowTools(!showTools)}
            className="flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          >
            <Wrench size={12} />
            {agent.toolCalls.length}
          </button>
        )}
        <button
          type="button"
          onClick={onShowInGraph}
          title="在协作图中查看"
          className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Workflow size={13} />
        </button>
        <StatusLabel status={agent.status} />
      </div>

      {/* Tool calls (expanded) */}
      {showTools && hasTools && (
        <div className="space-y-1 px-3 pb-2">
          {agent.toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCallState }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border/50 bg-card text-xs">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {call.status === "running" ? (
          <Loader2 size={12} className="animate-spin text-primary" />
        ) : (
          <Wrench size={12} className="text-muted-foreground" />
        )}
        <span className="flex-1 font-mono text-foreground">
          {call.toolName}
        </span>
        <span
          className={
            call.status === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }
        >
          {call.status === "running"
            ? "执行中"
            : call.status === "error"
              ? "失败"
              : "完成"}
        </span>
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-border/50 px-2.5 py-2">
          {Object.keys(call.arguments).length > 0 && (
            <div>
              <span className="text-muted-foreground">参数：</span>
              <pre className="mt-0.5 overflow-x-auto rounded bg-muted p-1.5 font-mono">
                {JSON.stringify(call.arguments, null, 2)}
              </pre>
            </div>
          )}
          {call.result && (
            <div>
              <span className="text-muted-foreground">结果：</span>
              <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-muted p-1.5 font-mono">
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIndicator({
  status,
}: {
  status: AgentState["status"];
}) {
  switch (status) {
    case "working":
      return <Loader2 size={14} className="animate-spin text-primary" />;
    case "completed":
      return <div className="size-3 rounded-full bg-success" />;
    case "error":
      return <div className="size-3 rounded-full bg-destructive" />;
    default:
      return <div className="size-3 rounded-full bg-muted-foreground/30" />;
  }
}

function StatusLabel({ status }: { status: AgentState["status"] }) {
  const labels: Record<AgentState["status"], string> = {
    idle: "等待中",
    working: "执行中",
    completed: "已完成",
    error: "失败",
  };
  return (
    <span className="text-xs text-muted-foreground">{labels[status]}</span>
  );
}
