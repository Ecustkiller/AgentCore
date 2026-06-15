import { Markdown } from "@/components/chat/Markdown";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type DebateRound,
  type Execution,
  type RunNode,
  STANCE_META,
  type Stance,
  debateGroups,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { ChevronDown, ChevronRight, ChevronUp, Columns2 } from "lucide-react";
import { useState } from "react";

/**
 * 辩论/审查「左右并排对比」(前端UX目标态 §四④, 落点 B).
 *
 * Rendered below the team graph for a debate turn: each comparison group's 正方 /
 * 反方 worker outputs sit side by side in the 896px reading column, so the user
 * weighs the opposing cases at a glance instead of opening each run one at a time.
 * A turn may carry several opposing pairs (multi-dimension review) — one row per
 * `group`. Clicking a side opens its full run detail in the right panel (the
 * single home for deep run detail), so this card stays a focused comparison.
 *
 * Pure projection: reads the same per-message {@link Execution} the graph does, so
 * live and replayed debate turns render identically and there is no second source
 * of truth.
 */
export function DebateCompare({
  execution,
  messageId,
}: {
  execution: Execution;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const groups = debateGroups(execution);
  if (groups.length === 0) return null;

  return (
    <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <Columns2 size={15} className="shrink-0 text-info" />
        <span className="flex-1 text-sm font-medium text-foreground">
          辩论对比
        </span>
        {expanded ? (
          <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border p-4">
          {groups.map((group) => {
            // 真·多轮辩论 (前端UX目标态 §四): a group whose runs carry round tags lays
            // out 逐轮 (each turn its own 正/反 row); a plain single-round debate (all
            // round 0) keeps the flat 正方 vs 反方 grid — same projection, two layouts.
            const isMultiRound = group.rounds.some((r) => r.round > 0);
            return isMultiRound ? (
              <div key={group.key} className="space-y-3">
                {group.rounds.map((round) => (
                  <RoundRow
                    key={round.round}
                    round={round}
                    execution={execution}
                    messageId={messageId}
                  />
                ))}
              </div>
            ) : (
              <div key={group.key} className="grid grid-cols-2 gap-3">
                <SideColumn
                  side="pro"
                  runs={group.pro}
                  execution={execution}
                  messageId={messageId}
                />
                <SideColumn
                  side="con"
                  runs={group.con}
                  execution={execution}
                  messageId={messageId}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One turn of a 真·多轮辩论 (前端UX目标态 §四): a「第 N 轮」label above that round's
 * 正/反 columns, so the user reads the exchange turn by turn (第 k 轮的一方 rebuts the
 * other's 第 k-1 轮, wired by the CEO via cross-round depends_on). */
function RoundRow({
  round,
  execution,
  messageId,
}: {
  round: DebateRound;
  execution: Execution;
  messageId: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
        第 {round.round} 轮
      </span>
      <div className="grid grid-cols-2 gap-3">
        <SideColumn
          side="pro"
          runs={round.pro}
          execution={execution}
          messageId={messageId}
        />
        <SideColumn
          side="con"
          runs={round.con}
          execution={execution}
          messageId={messageId}
        />
      </div>
    </div>
  );
}

/** One side of a comparison group: a labelled column stacking that side's worker
 * output(s). Empty when the CEO tagged only one side (honest gap, not a crash). */
function SideColumn({
  side,
  runs,
  execution,
  messageId,
}: {
  side: Stance;
  runs: RunNode[];
  execution: Execution;
  messageId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/30">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="rounded-full bg-info/10 px-1.5 py-0.5 text-xs font-medium text-info">
          {STANCE_META[side].label}
        </span>
      </div>
      <div className="space-y-3 p-3">
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            （无{STANCE_META[side].label}产出）
          </p>
        ) : (
          runs.map((run) => (
            <OutputCell
              key={run.id}
              run={run}
              execution={execution}
              messageId={messageId}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** A single worker's output in a side column: a clickable role header (drills into
 * the full run detail) above the rendered markdown, with a graceful placeholder
 * while the run is still streaming / failed / silent. Output is height-capped so a
 * long case does not blow the card up; the full text lives in the detail panel. */
function OutputCell({
  run,
  execution,
  messageId,
}: {
  run: RunNode;
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const agent = execution.agents.find((a) => a.id === run.agentId);
  const role = agent?.role ?? run.agentId;
  const output = agent ? agent.outputChunks.join("") : "";

  return (
    <div className="min-w-0">
      <SimpleTooltip label="查看完整产出">
        <button
          type="button"
          onClick={() => showRunDetail(messageId, run.id, role)}
          className="group/cell mb-1.5 flex w-full items-center gap-1.5 text-left"
        >
          <StatusDot status={run.status} />
          <span className="flex-1 truncate text-xs font-medium text-foreground">
            {role}
          </span>
          <ChevronRight
            size={13}
            className="shrink-0 text-muted-foreground/50 group-hover/cell:text-muted-foreground"
          />
        </button>
      </SimpleTooltip>
      {output ? (
        <div className="max-h-96 overflow-y-auto text-sm">
          <Markdown content={output} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{placeholder(run)}</p>
      )}
    </div>
  );
}

/** What to show in a side cell before there is output text. */
function placeholder(run: RunNode): string {
  if (run.status === "running") return "正在生成…";
  if (run.status === "failed") return run.error ?? "该立场执行失败。";
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
