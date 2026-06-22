import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type Execution,
  type RevisionChain,
  type RevisionVersion,
  type RunNode,
  revisionChains,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { ChevronDown, ChevronRight, ChevronUp, History } from "lucide-react";
import { useState } from "react";

/**
 * 定向唤回 续写「版本对比」(乙 热修 P4, P-2 保留版本链).
 *
 * Rendered below the team graph whenever a worker was revised: each revised
 * worker's version chain — the original (v1) plus every「修订 vN」续写 — sits side
 * by side in the reading column, so the user weighs how the product evolved at a
 * glance instead of opening each version one at a time. A turn may revise several
 * workers — one row per chain. Clicking a version opens its full run detail in the
 * right panel (the single home for deep run detail), so this card stays a focused
 * comparison.
 *
 * Pure projection: reads the same per-message {@link Execution} the graph does
 * (revisions are synthesized into it from their `run_started` frames), so live and
 * replayed turns render identically with no second source of truth — exactly like
 * {@link DebateBody} for debates.
 */
export function RevisionCompare({
  execution,
  messageId,
  bare = false,
}: {
  execution: Execution;
  messageId: string;
  /** Drop the card chrome + collapsible header (chains only, always shown) for a host
   * that supplies its own frame + title — e.g. the canvas focused node's foot drawer
   * ({@link import("../graph/FocusedTurnNode")}). Verbatim reuse, no fork. */
  bare?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const chains = revisionChains(execution);
  if (chains.length === 0) return null;

  const rows = (
    <div
      className={bare ? "space-y-4" : "space-y-4 border-t border-border p-4"}
    >
      {chains.map((chain) => (
        <ChainRow
          key={chain.originalId}
          chain={chain}
          execution={execution}
          messageId={messageId}
        />
      ))}
    </div>
  );
  if (bare) return rows;

  return (
    <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start rounded-none px-4 py-3 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-2 text-left">
          <History size={15} className="shrink-0 text-primary" />
          <span className="flex-1 text-sm font-medium text-foreground">
            版本对比
          </span>
          {expanded ? (
            <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
          )}
        </span>
      </Button>

      {expanded && rows}
    </div>
  );
}

/** One revised worker's version chain: a role label above its versions laid out
 * left → right (v1 原始 → v2 → v3 …), so the user reads the evolution in order. */
function ChainRow({
  chain,
  execution,
  messageId,
}: {
  chain: RevisionChain;
  execution: Execution;
  messageId: string;
}) {
  const original = chain.versions[0].run;
  const agent = execution.agents.find((a) => a.id === original.agentId);
  const role = agent?.role ?? original.agentId;

  return (
    <div className="space-y-1.5">
      <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
        {role}
      </span>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${chain.versions.length}, minmax(0, 1fr))`,
        }}
      >
        {chain.versions.map((version) => (
          <VersionColumn
            key={version.run.id}
            version={version}
            role={role}
            execution={execution}
            messageId={messageId}
          />
        ))}
      </div>
    </div>
  );
}

/** One version in the chain: a clickable「vN」header (drills into the full run
 * detail) above the rendered markdown, with a graceful placeholder while the
 * revision is still streaming / failed. Output is height-capped so a long draft
 * does not blow the card up; the full text lives in the detail panel. */
function VersionColumn({
  version,
  role,
  execution,
  messageId,
}: {
  version: RevisionVersion;
  role: string;
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const { run } = version;
  const agent = execution.agents.find((a) => a.id === run.agentId);
  const output = agent ? agent.outputChunks.join("") : "";

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/30">
      <SimpleTooltip label="查看完整产出">
        <Button
          variant="ghost"
          onClick={() => showRunDetail(messageId, run.id, role)}
          className="group/cell h-auto w-full justify-start gap-1.5 rounded-none border-b border-border px-3 py-2 hover:bg-transparent"
        >
          <span className="flex w-full items-center gap-1.5 text-left">
            <StatusDot status={run.status} />
            <span className="flex-1 truncate text-xs font-medium text-foreground">
              v{version.version}
              {version.version === 1 && (
                <span className="ml-1 font-normal text-muted-foreground">
                  原始
                </span>
              )}
            </span>
            <ChevronRight
              size={13}
              className="shrink-0 text-muted-foreground/50 group-hover/cell:text-muted-foreground"
            />
          </span>
        </Button>
      </SimpleTooltip>
      <div className="p-3">
        {output ? (
          <div className="max-h-96 overflow-y-auto text-sm">
            <Markdown content={output} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{placeholder(run)}</p>
        )}
      </div>
    </div>
  );
}

/** What to show in a version cell before there is output text. */
function placeholder(run: RunNode): string {
  if (run.status === "running") return "正在修订…";
  if (run.status === "failed") return run.error ?? "该版本执行失败。";
  if (run.status === "cancelled") return "已停止。";
  return "（暂无输出）";
}

const STATUS_DOT: Record<RunNode["status"], string> = {
  pending: "bg-muted-foreground/30",
  ready: "bg-muted-foreground/30",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/30",
};

function StatusDot({ status }: { status: RunNode["status"] }) {
  return (
    <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
  );
}
