import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Loader2, MessageSquare } from "lucide-react";

/**
 * 简单回合竖排退化卡（前端UX设计.md §6.1）: a single-agent turn
 * (`executionId === null`) on the persistent conversation canvas. A team turn folds
 * into a {@link import("./TurnSummaryNode")} DAG-summary; a plain Q&A has no team to
 * draw, so it degenerates to a light card in the same vertical spine — the canvas
 * stays a faithful record of the whole conversation without faking a graph.
 *
 * Read-only context (the full answer lives in 聊天 view): shows the prompt as title
 * and a short answer snippet. Quieter than {@link TurnSummaryNode} so the eye goes
 * to the real teamwork.
 */
export interface SimpleTurnData {
  prompt: string;
  answer: string;
  running: boolean;
  [key: string]: unknown;
}

export function SimpleTurnNode({ data }: NodeProps) {
  const d = data as SimpleTurnData;
  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div className="w-[320px] rounded-xl border border-border bg-muted/30 px-3.5 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
            {d.running ? (
              <Loader2 size={14} className="animate-spin text-primary" />
            ) : (
              <MessageSquare size={14} className="text-muted-foreground" />
            )}
          </div>
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {d.prompt || "直接回答"}
          </p>
        </div>
        {d.answer && (
          <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {d.answer}
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </>
  );
}
