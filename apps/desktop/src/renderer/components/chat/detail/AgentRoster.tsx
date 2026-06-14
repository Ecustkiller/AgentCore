import { splitPayroll } from "@/lib/cost";
import { formatCost } from "@/lib/format";
import {
  activeRuntime,
  selectLastAssistantCostTotal,
  useConversationStore,
} from "@/stores/conversation";
import { useDetailPanelStore } from "@/stores/detailPanel";
import {
  type AgentState,
  type Execution,
  useActiveExecField,
  useExecutionStore,
} from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import { Loader2, Workflow, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";

/**
 * Team payroll for the panel's progress tab (§7.3B) — the differentiator: cost
 * overlaid on the live agent roster, one row per participating run, plus a CEO
 * row for the captain's own spend. A row click pins that agent's run and switches
 * to the detail tab; the focus lives in the execution store, so selecting here
 * also highlights the graph.
 *
 * 别人只能说「这次花了 ¥X」；这里说「CEO ¥0.03 / 调研员 ¥0.05 / 写作 ¥0.04」。
 */
export function AgentRoster({ execution }: { execution: Execution }) {
  const focusedAgentId = useActiveExecField((rt) => rt.focusedAgentId);
  const focusAgent = useExecutionStore((s) => s.focusAgent);
  const showRunDetail = useDetailPanelStore((s) => s.showRunDetail);
  const openGraph = useUIStore((s) => s.openGraph);
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  // 合计 = the turn total on the last assistant message (captain + members), the
  // authoritative aggregate from message_end; null until the turn ends.
  const turnTotal = useConversationStore((s) =>
    selectLastAssistantCostTotal(activeRuntime(s).messages),
  );

  // The CEO synthesis run (Phase B) is the captain's own work surfaced as a real
  // run. It is NOT a worker — exclude its agent from the worker rows so the CEO
  // isn't listed twice, and back the captain row with it so that row drills into
  // the 汇总过程 (its own cost is 0 / rolled into the captain split below).
  const synthesisRun =
    execution.runs.find((r) => r.kind === "synthesis") ?? null;
  // One payroll row per worker (its priced run); cost lights up as runs finish.
  const workerRows = execution.agents
    .filter((agent) => agent.id !== synthesisRun?.agentId)
    .map((agent) => {
      const run = execution.runs.find((s) => s.agentId === agent.id);
      return { agent, run, cost: run?.cost?.total ?? 0 };
    });
  // CEO split + bar normalisation live in a pure helper (`lib/cost.ts`) so the
  // money math is unit-tested: the captain has no scheduled run, so its spend is
  // the turn total minus the workers (exact — same per-run prices), shown only
  // once the turn total is known (message_end); bars normalise over the max row.
  const { captainCost, total, maxCost } = splitPayroll(
    turnTotal,
    workerRows.map((r) => r.cost),
  );

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          团队工资单
        </span>
        {total > 0 && (
          <span className="text-xs text-muted-foreground">
            合计 {formatCost(total, cnyPerUsd)}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {captainCost > 0 && (
          <CaptainRow
            cost={captainCost}
            maxCost={maxCost}
            cnyPerUsd={cnyPerUsd}
            focused={!!synthesisRun && focusedAgentId === synthesisRun.agentId}
            onSelect={
              synthesisRun
                ? () => showRunDetail(synthesisRun.id, "CEO")
                : undefined
            }
          />
        )}
        {workerRows.map(({ agent, run, cost }) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            cost={cost}
            maxCost={maxCost}
            cnyPerUsd={cnyPerUsd}
            focused={focusedAgentId === agent.id}
            onSelect={() => {
              if (run) {
                showRunDetail(run.id, agent.role);
              } else {
                focusAgent(agent.id);
              }
            }}
            onShowInGraph={() => {
              focusAgent(agent.id);
              openGraph();
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** Cost as a proportion bar + a ¥ caption (大众面). 0 / unknown shows「—」, not
 * 「¥0.00」(§7.5); the bar uses `primary` (neutral — status is the row's ring). */
function CostMeter({
  cost,
  maxCost,
  cnyPerUsd,
}: {
  cost: number;
  maxCost: number;
  cnyPerUsd: number;
}) {
  const pct = maxCost > 0 ? Math.round((cost / maxCost) * 100) : 0;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
        {formatCost(cost, cnyPerUsd)}
      </span>
    </div>
  );
}

/** The CEO's own payroll line (captain spend), derived as the turn total minus
 * the workers. When a synthesis run backs it (Phase B), the label becomes a
 * button that drills into the 汇总过程; otherwise it stays a static line (the
 * captain is the pipeline, with no single run to open). */
function CaptainRow({
  cost,
  maxCost,
  cnyPerUsd,
  focused = false,
  onSelect,
}: {
  cost: number;
  maxCost: number;
  cnyPerUsd: number;
  focused?: boolean;
  onSelect?: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) {
      rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focused]);

  return (
    <div
      ref={rowRef}
      className={`rounded-lg transition-colors ${
        focused ? "bg-primary/10 ring-1 ring-primary" : "bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="size-3 shrink-0 rounded-full bg-success" />
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            className="flex-1 truncate text-left text-sm text-foreground"
          >
            CEO <span className="text-muted-foreground">· 编排·汇总</span>
          </button>
        ) : (
          <span className="flex-1 truncate text-sm text-foreground">
            CEO <span className="text-muted-foreground">· 编排</span>
          </span>
        )}
        <CostMeter cost={cost} maxCost={maxCost} cnyPerUsd={cnyPerUsd} />
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  cost,
  maxCost,
  cnyPerUsd,
  focused,
  onSelect,
  onShowInGraph,
}: {
  agent: AgentState;
  cost: number;
  maxCost: number;
  cnyPerUsd: number;
  focused: boolean;
  onSelect: () => void;
  onShowInGraph: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const toolCount = agent.toolCalls.length;

  // Bring the row into view when it becomes the focused one (e.g. selected from
  // the graph, then returning to the conversation).
  useEffect(() => {
    if (focused) {
      rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focused]);

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
          onClick={onSelect}
          className="flex-1 truncate text-left text-sm text-foreground"
        >
          {agent.role}
        </button>
        {toolCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Wrench size={12} />
            {toolCount}
          </span>
        )}
        <CostMeter cost={cost} maxCost={maxCost} cnyPerUsd={cnyPerUsd} />
        <button
          type="button"
          onClick={onShowInGraph}
          title="在协作图中查看"
          className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Workflow size={13} />
        </button>
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: AgentState["status"] }) {
  switch (status) {
    case "working":
      return (
        <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
      );
    case "completed":
      return <div className="size-3 shrink-0 rounded-full bg-success" />;
    case "error":
      return <div className="size-3 shrink-0 rounded-full bg-destructive" />;
    default:
      return (
        <div className="size-3 shrink-0 rounded-full bg-muted-foreground/30" />
      );
  }
}
