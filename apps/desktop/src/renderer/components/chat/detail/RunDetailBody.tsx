import { EscalationCard } from "@/components/chat/EscalationCard";
import { Markdown } from "@/components/chat/Markdown";
import { ReceivedContextSection } from "@/components/chat/ReceivedContext";
import {
  type ToolResultData,
  ToolResultView,
  hasToolResultBody,
  toolResultPeek,
} from "@/components/chat/toolResult/ToolResultView";
import { Button } from "@/components/ui";
import { formatCompact, formatCost, formatUsd } from "@/lib/format";
import { activeRuntime, useConversationStore } from "@/stores/conversation";
import {
  type AgentState,
  type BatchMetricsSnapshot,
  MODEL_TIER_META,
  type RunEscalation,
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
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
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
      <Button
        variant="ghost"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`h-auto w-full justify-start gap-2 px-0 py-0 hover:bg-transparent ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="flex w-full items-center gap-2 text-left">
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
        </span>
      </Button>
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
  const diagnosticMode = useUIStore((s) => s.diagnosticMode);
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  // 诊断模式 (前端UX设计.md §十): the turn's trace id, read from its message so the
  // diagnostic panel can show the single key that ties this run back to the server
  // logs. Null unless the message carried one (DEV / live turns).
  const traceId = useConversationStore(
    (s) =>
      activeRuntime(s).messages.find((m) => m.id === messageId)?.traceId ??
      null,
  );
  // 阻塞式求决策 §4.5B/§4.7: a pending escalation is answerable只在回合仍 live 时（与气泡卡
  // 同一 interactive 门控）；重载 / 已结束的回合渲染为静态记录。按「回合非终态」(isStreaming)
  // 取，而非单个 run —— 升级 worker 可能 parked 而其它队员仍在跑。
  const turnInteractive = useConversationStore(
    (s) =>
      activeRuntime(s).messages.find((m) => m.id === messageId)?.isStreaming ??
      false,
  );

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

      {run.escalations.length > 0 && (
        <EscalationSection
          run={run}
          role={agent.role}
          conversationId={conversationId}
          interactive={turnInteractive}
        />
      )}

      {run.receivedContext.length > 0 && (
        <ReceivedContextSection
          blocks={run.receivedContext}
          defaultExpanded={usageDetail}
          powerMode={usageDetail}
        />
      )}

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
          agent={agent}
          cnyPerUsd={cnyPerUsd}
          defaultExpanded={usageDetail}
        />
      )}

      {diagnosticMode && (
        <DiagnosticSection
          run={run}
          executionId={execution.id}
          traceId={traceId}
          batches={execution.batches}
        />
      )}
    </div>
  );
}

/**
 * Stable React key for a run escalation row. Blocking escalations carry `id`; raised
 * banners have no wire id, so fall back to content fields (append-only list).
 */
function escalationRowKey(esc: RunEscalation): string {
  if (esc.id) return esc.id;
  return `${esc.status}:${esc.question}:${esc.assumption}:${esc.blocking}`;
}

/**
 * 升级实时可见 + 阻塞式求决策 §4.5B: a worker's escalations (`escalate`), rendered by
 * lifecycle `status` rather than a flat list:
 *
 *  - `raised` (非阻塞 `run_escalation`) — the worker flagged a 待决问题 but kept working
 *    under its assumption; the CEO resolves it at synthesis. Read-only here.
 *  - `pending` / `resolved` / `timeout` (阻塞·求决策) — reuse the SAME {@link EscalationCard}
 *    as the assistant bubble so a pending one is 就地可应答 while the turn is live
 *    (`interactive`), then shows the answer / 已按假设继续 / a dormant record once settled.
 */
function EscalationSection({
  run,
  role,
  conversationId,
  interactive,
}: {
  run: RunNode;
  role: string;
  conversationId: string | null;
  interactive: boolean;
}) {
  return (
    <Section title={`向上升级 (${run.escalations.length})`}>
      <div className="space-y-2">
        {run.escalations.map((esc) =>
          esc.status === "raised" ? (
            <RaisedEscalationRow key={escalationRowKey(esc)} esc={esc} />
          ) : (
            <EscalationCard
              key={escalationRowKey(esc)}
              escalation={esc}
              role={role}
              conversationId={conversationId}
              interactive={interactive}
            />
          ),
        )}
      </div>
    </Section>
  );
}

/** A non-blocking escalation (`run_escalation`): the worker flagged a 待决问题 but kept
 * working under its assumption, so this is read-only — the CEO resolves it at synthesis.
 * A「阻断性」flag marks one where a wrong guess would void the product. */
function RaisedEscalationRow({ esc }: { esc: RunEscalation }) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-warning">
        <ArrowUp size={12} className="shrink-0" />
        <span>向上求决策</span>
        {esc.blocking && (
          <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-warning">
            阻断性
          </span>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
        {esc.question}
      </p>
      {esc.assumption && (
        <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
          <span className="text-muted-foreground/70">暂用假设：</span>
          {esc.assumption}
        </p>
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
            <Button
              variant="ghost"
              onClick={() => onSelect(r.id, role)}
              className="h-auto w-full justify-start gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              <span className="flex w-full items-center gap-2 text-left">
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
              </span>
            </Button>
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
            <Button
              key={r.id}
              variant="ghost"
              onClick={() => onSelect(r.id, role)}
              className="h-auto w-full justify-start gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs hover:bg-accent"
            >
              <span className="flex w-full items-center gap-2 text-left">
                <RunStatusDot status={r.status} />
                <span className="shrink-0 font-medium text-foreground">
                  {role}
                </span>
                <span className="flex-1 truncate text-muted-foreground">
                  {r.task}
                </span>
              </span>
            </Button>
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
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
            思考过程
          </span>
          {live && (
            <span className="shrink-0 text-xs text-primary">思考中…</span>
          )}
        </span>
      </Button>

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
  agent,
  cnyPerUsd,
  defaultExpanded,
}: {
  run: RunNode;
  agent: AgentState;
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
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
            资源消耗
          </span>
          {cost && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatCost(cost.total, cnyPerUsd)}
            </span>
          )}
        </span>
      </Button>

      {expanded && (
        <div className="mt-2 space-y-2 rounded-lg bg-muted p-3">
          <MetricRow
            label="档位"
            value={MODEL_TIER_META[agent.modelPreference].label}
          />
          <MetricRow
            label="思考"
            value={reasoningMeta(agent.thinking, agent.reasoningEffort).label}
          />
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

/**
 * 诊断 / 开发者面板 (前端UX设计.md §十) — gated behind 诊断模式, never shown to 大众.
 * Surfaces the low-level identifiers that tie this run to the server journal + logs
 * (run / agent / execution / trace ids, the run's wire shape): noise for normal use,
 * but the first thing you reach for when debugging a turn. Display-only, selectable
 * mono text; the message bubble carries the one-click trace-id copy.
 */
function DiagnosticSection({
  run,
  executionId,
  traceId,
  batches,
}: {
  run: RunNode;
  executionId: string;
  traceId: string | null;
  batches: BatchMetricsSnapshot[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="mb-4 last:mb-0">
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
            诊断信息
          </span>
        </span>
      </Button>

      {expanded && (
        <div className="mt-2 select-text space-y-2 rounded-lg bg-muted p-3">
          <DiagRow label="运行 ID" value={run.id} />
          <DiagRow label="Agent ID" value={run.agentId} />
          <DiagRow label="类型" value={run.kind} />
          {run.parentRunId && (
            <DiagRow label="上级运行" value={run.parentRunId} />
          )}
          {run.dependsOn.length > 0 && (
            <DiagRow label="依赖" value={run.dependsOn.join(", ")} />
          )}
          {run.model && <DiagRow label="模型" value={run.model} />}
          <DiagRow label="执行 ID" value={executionId} />
          <DiagRow label="Trace ID" value={traceId ?? "—"} />
          {batches.length > 0 && <SchedulingDiag batches={batches} />}
        </div>
      )}
    </section>
  );
}

/** 调度埋点量化 (深层诊断指标, §十): the turn's WaveScheduler snapshot(s), rendered inside
 * 诊断信息. Execution-level (not run-scoped) — it answers「这回合的并发真的发生了吗 / width 卡没卡
 * / 自我纠偏触发了几次」. Most turns carry one batch; a checkpoint/scope yield + resume adds more.
 * Exported for the render test (the panel is dev-gated, so the shoot harness never reaches it). */
export function SchedulingDiag({
  batches,
}: { batches: BatchMetricsSnapshot[] }) {
  return (
    <div className="mt-1 border-t border-border/60 pt-2">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        调度{batches.length > 1 ? ` · ${batches.length} 批` : ""}
      </p>
      {batches.map((b, i) => (
        <div
          key={`${b.wallMs}-${b.nodes}-${b.peakRunning}-${b.width}`}
          className="mb-2 space-y-1 last:mb-0"
        >
          {batches.length > 1 && (
            <p className="text-[11px] text-muted-foreground">批次 {i + 1}</p>
          )}
          <DiagRow
            label="节点 / 并发"
            value={`${b.nodes} · 上限 ${b.width} · 峰值 ${b.peakRunning}`}
          />
          <DiagRow
            label="平均并发 / 用时"
            value={`${b.wallMs > 0 ? (b.busyMs / b.wallMs).toFixed(2) : "—"} · ${b.wallMs}ms`}
          />
          <DiagRow label="结果" value={schedOutcome(b)} />
          {b.slotStarved > 0 && (
            <DiagRow label="槽位等待" value={`${b.slotStarved} 次`} />
          )}
          {(b.bindBoundaries > 0 ||
            b.scopeBoundaries > 0 ||
            b.checkpointBoundaries > 0) && (
            <DiagRow
              label="自我纠偏"
              value={`绑定 ${b.bindBoundaries} · 操舵 ${b.scopeBoundaries} · 复核 ${b.checkpointBoundaries}`}
            />
          )}
          {b.escalations > 0 && (
            <DiagRow
              label="队员上报"
              value={`${b.escalations}（scope ${b.scopeEscalations}）`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** 调度结果一行：完成数恒显，失败 / 跳过仅在 >0 时追加（无则不喧宾夺主）。 */
function schedOutcome(b: BatchMetricsSnapshot): string {
  const parts = [`完成 ${b.completed}`];
  if (b.failed > 0) parts.push(`失败 ${b.failed}`);
  if (b.skipped > 0) parts.push(`跳过 ${b.skipped}`);
  return parts.join(" · ");
}

/** One diagnostic id row — left label, right mono value that wraps (`break-all`)
 * so a long UUID never overflows the narrow run-detail column. */
function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="break-all text-right font-mono text-xs text-foreground">
        {value}
      </span>
    </div>
  );
}
