import type { Execution } from "@/stores/execution";
import { AgentRoster } from "./AgentRoster";

/** Panel "progress" tab: overall progress bar + the team roster. */
export function ProgressTab({ execution }: { execution: Execution }) {
  const { completed, total } = execution.progress;

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {execution.taskSummary}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {completed}/{total}
        </span>
      </div>

      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: total > 0 ? `${(completed / total) * 100}%` : "0%" }}
        />
      </div>

      <AgentRoster execution={execution} />
    </div>
  );
}
