import { Markdown } from "@/components/chat/Markdown";
import {
  type ToolResultData,
  ToolResultView,
  hasToolResultBody,
  toolResultPeek,
} from "@/components/chat/toolResult/ToolResultView";
import { formatCompact, formatCost, formatUsd } from "@/lib/format";
import {
  type AgentState,
  MODEL_TIER_META,
  type RunNode,
  type ToolCallState,
  reasoningMeta,
  toolLabel,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Cpu,
  Wrench,
} from "lucide-react";
import { useState } from "react";

/** One tool call in a worker's run detail: a click-to-expand row that reveals the
 * rich result (工具结果富渲染) — a search's cards, a code run's terminal, an edit's
 * diff — or the text result, via the shared {@link ToolResultView}. */
function RunToolRow({ tc }: { tc: ToolCallState }) {
  const [open, setOpen] = useState(false);
  const data: ToolResultData = {
    toolName: tc.toolName,
    args: tc.arguments,
    result: tc.result,
    display: tc.display,
    status: tc.status,
  };
  const hasBody = hasToolResultBody(data);
  const statusClass =
    tc.status === "error"
      ? "text-destructive"
      : tc.status === "running"
        ? "text-primary"
        : "text-muted-foreground";
  return (
    <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 text-left ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <Wrench size={12} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-foreground">
            {tc.toolName}
          </span>
          {hasBody && !open && (
            <span
              className={`block truncate ${
                tc.status === "error"
                  ? "text-destructive/80"
                  : "text-muted-foreground/70"
              }`}
            >
              {toolResultPeek(data)}
            </span>
          )}
        </span>
        <span className={`shrink-0 ${statusClass}`}>
          {tc.status === "running"
            ? "执行中"
            : tc.status === "error"
              ? "失败"
              : "完成"}
        </span>
      </button>
      {open && hasBody && <ToolResultView data={data} />}
    </div>
  );
}

/**
 * Single-run detail content (task / status / model+reasoning / tools / output /
 * summary), read from the live-or-replayed execution projection by run id.
 *
 * Bound to a specific message's execution slot (§9.3) via `messageId`, so the
 * conversation's right-side detail panel can pin a run from any turn (live or
 * historical) — the single home for run detail, reached from both the embedded
 * graph and the full-screen overlay. Chrome-free on purpose, so the drill-down
 * view is identical wherever it appears.
 */
export function RunDetailBody({
  messageId,
  runId,
}: {
  messageId: string;
  runId: string;
}) {
  const execution = useMessageExecution(messageId);
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const usageDetail = useUIStore((s) => s.usageDetail);
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);

  const run = execution?.runs.find((s) => s.id === runId);
  const agent = run
    ? execution?.agents.find((a) => a.id === run.agentId)
    : null;

  if (!execution || !run || !agent) return null;

  const output = agent.outputChunks.join("");
  const reasoning = agent.reasoningChunks.join("");
  // The worker is mid-think until its first output token lands (DeepSeek streams
  // the whole reasoning_content before any content), so the live thinking cursor
  // shows only in that window — and not while it is actively composing a tool call
  // (the「正在生成」row below carries that liveliness instead).
  const thinkingLive =
    agent.status === "working" && output.length === 0 && !agent.toolProgress;
  // This run's neighbours in the collaboration DAG, shown honestly by direction:
  // 依赖 (upstream — runs this one consumed, from `dependsOn`) and 后续
  // (downstream — runs that consume this one's output). Kept distinct from the
  // delegation tree below (上级 / 子任务, from `parentRunId`): DAG edges are
  // horizontal (same wave), delegation edges are vertical (阶段2 nesting).
  const upstream = run.dependsOn
    .map((id) => execution.runs.find((r) => r.id === id))
    .filter((r): r is RunNode => r != null);
  const downstream = execution.runs.filter((r) => r.dependsOn.includes(run.id));
  // Delegation tree (阶段2 嵌套子任务): 上级 is the captain that delegated this run
  // — only when its parent is a real run on this turn's graph (a top-level
  // worker's parent is the CEO captain, which has no node here, so this is null);
  // 子任务 are the runs THIS one delegated, rendered as an indented tree below.
  const parent =
    run.parentRunId != null
      ? (execution.runs.find((r) => r.id === run.parentRunId) ?? null)
      : null;
  const childCount = countDescendants(execution.runs, run.id);

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {agent.role}
        </span>
        <StatusBadge status={run.status} />
        {run.durationMs != null && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {(run.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      <Section title="任务">
        <Markdown content={run.task} />
      </Section>

      <Section title="模型与推理">
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
      </Section>

      {(reasoning || thinkingLive) && (
        <ThinkingSection reasoning={reasoning} live={thinkingLive} />
      )}

      {run.error && (
        <Section title="错误">
          <p className="whitespace-pre-wrap break-words text-xs text-destructive">
            {run.error}
          </p>
        </Section>
      )}

      {agent.toolProgress && agent.status === "working" && (
        <Section title="正在生成">
          <div className="flex items-center gap-2 rounded-lg bg-primary/5 px-2.5 py-1.5 text-xs">
            <Wrench size={12} className="shrink-0 text-primary" />
            <span className="flex-1 truncate text-foreground">
              {toolLabel(agent.toolProgress.toolName)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {agent.toolProgress.chars > 0
                ? `${formatCompact(agent.toolProgress.chars)} 字`
                : "…"}
            </span>
            <span className="inline-block animate-pulse text-primary">▋</span>
          </div>
        </Section>
      )}

      {agent.toolCalls.length > 0 && (
        <Section title={`工具调用 (${agent.toolCalls.length})`}>
          <div className="space-y-1">
            {agent.toolCalls.map((tc) => (
              <RunToolRow key={tc.id} tc={tc} />
            ))}
          </div>
        </Section>
      )}

      {output && (
        <Section title="输出">
          <div className="rounded-lg bg-muted p-3">
            <Markdown
              content={output}
              isStreaming={agent.status === "working"}
            />
          </div>
        </Section>
      )}

      {run.outputSummary && (
        <Section title="摘要">
          <Markdown content={run.outputSummary} />
        </Section>
      )}

      {(upstream.length > 0 || downstream.length > 0) && (
        <Section title="协作关系">
          <div className="space-y-3">
            {upstream.length > 0 && (
              <RunRefGroup
                label="依赖"
                runs={upstream}
                agents={execution.agents}
                onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
              />
            )}
            {downstream.length > 0 && (
              <RunRefGroup
                label="后续"
                runs={downstream}
                agents={execution.agents}
                onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
              />
            )}
          </div>
        </Section>
      )}

      {(parent || childCount > 0) && (
        <Section title="委派关系">
          <div className="space-y-3">
            {parent && (
              <RunRefGroup
                label="上级"
                runs={[parent]}
                agents={execution.agents}
                onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
              />
            )}
            {childCount > 0 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">
                  子任务（{childCount}）
                </p>
                <SubtaskTree
                  parentId={run.id}
                  runs={execution.runs}
                  agents={execution.agents}
                  depth={0}
                  onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
                />
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Every drillable run carries its own priced spend (§7.3B): a delegated
          worker and the CEO captain root are each metered once in the executor.
          Shown only when usage/cost are present (a run that never hit the LLM is
          unmetered → no ledger to render). */}
      {(run.usage || run.cost) && (
        <ResourceSection
          run={run}
          cnyPerUsd={cnyPerUsd}
          defaultExpanded={usageDetail}
        />
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
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
    cancelled: "已停止",
  };
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${styles[status] ?? ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

const STATUS_DOT: Record<string, string> = {
  pending: "bg-muted-foreground/30",
  ready: "bg-muted-foreground/30",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/30",
};

function RunStatusDot({ status }: { status: RunNode["status"] }) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status] ?? "bg-muted-foreground/30"}`}
    />
  );
}

/** Total nested runs under a run (direct children + their descendants). 阶段2
 * caps nesting at CEO → worker → sub-worker, so this stays shallow, but it is
 * written generally to match the indented tree it labels. */
function countDescendants(runs: RunNode[], parentId: string): number {
  return runs
    .filter((r) => r.parentRunId === parentId)
    .reduce((n, r) => n + 1 + countDescendants(runs, r.id), 0);
}

/**
 * The delegated sub-task tree under a run (阶段2 嵌套子任务), rendered as an
 * indented list: each row drills into that sub-worker's detail, and its own
 * children nest one level deeper behind a guide rail. Reuses the shared
 * run-detail focus so the panel and graph stay in sync.
 */
function SubtaskTree({
  parentId,
  runs,
  agents,
  depth,
  onSelect,
}: {
  parentId: string;
  runs: RunNode[];
  agents: AgentState[];
  depth: number;
  onSelect: (runId: string, title?: string) => void;
}) {
  const children = runs.filter((r) => r.parentRunId === parentId);
  if (children.length === 0) return null;
  return (
    <div
      className={
        depth > 0 ? "ml-2 space-y-1 border-l border-border pl-2" : "space-y-1"
      }
    >
      {children.map((r) => {
        const role = agents.find((a) => a.id === r.agentId)?.role ?? r.agentId;
        return (
          <div key={r.id} className="space-y-1">
            <button
              type="button"
              onClick={() => onSelect(r.id, role)}
              className="flex w-full items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-left text-xs hover:bg-accent"
            >
              <CornerDownRight
                size={12}
                className="shrink-0 text-muted-foreground/60"
              />
              <RunStatusDot status={r.status} />
              <span className="shrink-0 font-medium text-foreground">
                {role}
              </span>
              <span className="flex-1 truncate text-muted-foreground">
                {r.task}
              </span>
            </button>
            <SubtaskTree
              parentId={r.id}
              runs={runs}
              agents={agents}
              depth={depth + 1}
              onSelect={onSelect}
            />
          </div>
        );
      })}
    </div>
  );
}

/** A labelled list of related runs (依赖 / 后续 / 上级) — each row drills into
 * that run, reusing the shared run-detail focus so the panel and graph stay in
 * sync. */
function RunRefGroup({
  label,
  runs,
  agents,
  onSelect,
}: {
  label: string;
  runs: RunNode[];
  agents: AgentState[];
  onSelect: (runId: string, title?: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <div className="space-y-1">
        {runs.map((r) => {
          const role =
            agents.find((a) => a.id === r.agentId)?.role ?? r.agentId;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r.id, role)}
              className="flex w-full items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-left text-xs hover:bg-accent"
            >
              <RunStatusDot status={r.status} />
              <span className="shrink-0 font-medium text-foreground">
                {role}
              </span>
              <span className="flex-1 truncate text-muted-foreground">
                {r.task}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 思考全文 (run-scoped reasoning) — the worker's streamed thinking, folded from
 * `run_reasoning_delta`. Collapsible because a deep-think run's log can be long;
 * opens while the worker is still thinking (so you watch it stream), then folds
 * away for completed runs where 输出/摘要 are the focus. Rendered as raw
 * preformatted text — reasoning is a thought log, not markdown.
 */
function ThinkingSection({
  reasoning,
  live,
}: {
  reasoning: string;
  live: boolean;
}) {
  const [expanded, setExpanded] = useState(live);

  return (
    <section className="mb-4 last:mb-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5"
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
          思考过程
        </span>
        {live && <span className="shrink-0 text-xs text-primary">思考中…</span>}
      </button>

      {expanded && (
        <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
          {reasoning}
          {live && (
            <span className="ml-0.5 inline-block animate-pulse text-primary">
              ▋
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Per-run resource ledger (§7.3B power detail) — the single place a run's full
 * raw token + cost breakdown lives. Collapsed by default; opens by default when
 * the user has turned on 用量明细 (`usageDetail`). Money is never gated by that
 * toggle, so the ¥ total stays on the collapsed header. All-zero cost renders as
 * 「—」(§7.5), not「¥0.00」.
 */
function ResourceSection({
  run,
  cnyPerUsd,
  defaultExpanded,
}: {
  run: RunNode;
  cnyPerUsd: number;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { usage, cost, model } = run;
  const cacheRate =
    usage && usage.input > 0
      ? Math.round((usage.cache_hit / usage.input) * 100)
      : 0;

  return (
    <section className="mb-4 last:mb-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5"
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
          资源消耗
        </span>
        {cost && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatCost(cost.total, cnyPerUsd)}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 rounded-lg bg-muted p-3">
          {model && <MetricRow label="模型" value={model} mono />}

          {cost && (
            <div>
              <MetricRow
                label="成本"
                value={`${formatCost(cost.total, cnyPerUsd)} · ${formatUsd(cost.total)}`}
              />
              <p className="mt-0.5 text-xs text-muted-foreground">
                输入 {formatUsd(cost.input)} · 输出 {formatUsd(cost.output)}
                {cost.cached > 0 && <> · 缓存省 {formatUsd(cost.cached)}</>}
              </p>
            </div>
          )}

          {usage && (
            <>
              <div>
                <MetricRow
                  label="输入 token"
                  value={formatCompact(usage.input)}
                />
                <p className="mt-0.5 text-xs text-muted-foreground">
                  命中 {formatCompact(usage.cache_hit)} · 未命中{" "}
                  {formatCompact(usage.cache_miss)} · 缓存率 {cacheRate}%
                </p>
              </div>
              <div>
                <MetricRow
                  label="输出 token"
                  value={formatCompact(usage.output)}
                />
                <p className="mt-0.5 text-xs text-muted-foreground">
                  推理 {formatCompact(usage.reasoning)}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function MetricRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-right text-xs tabular-nums text-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
