import { DebateView, LiveDebateNarrative } from "@/components/DebateView";
import { Markdown } from "@/components/Markdown";
import { NonBlockingAskCard } from "@/components/NonBlockingAskCard";
import { TeamView } from "@/components/TeamView";
import {
  CONTEXT_CHANNEL_LABEL,
  toolDetail,
  toolLabel,
} from "@/components/assistantLabels";
import type { NonBlockingAsk, RunToolCall } from "@/protocol/fold";
// Rich assistant rendering shared by live turns and history replay (前端技术与架构 §七 ·
// 富渲染 + 多 Agent 团队视图). One {@link AssistantContent} consumes the same fields whether
// they come from the live fold (ProjectedTurn) or a persisted message (MessageDetail).
//
// 统一团队时间线: every turn renders its `process` timeline (正文 / 思考 / 工具, interleaved);
// for history it is restored from MessageDetail.runs.process. A multi-agent turn additionally
// carries a `team` positional marker in that timeline — the collaboration graph slots inline
// at the marker (协作图时间线落点), re-folded from MessageDetail.runs.events for history.
// The checkpoint·ask·plan_review markers are anchors for desktop's inline cards; mobile owns
// those interactions via its PauseCard, so they no-op in the timeline.
//
// Citations render as a source list under the message either way.
import type {
  Citation,
  ContextBlockWire,
  DebateNarrativeRound,
  DebateResultPayload,
  ProcessStep,
  ToolPhase,
} from "@agentcore/contract-types";
import type {
  ProjectedAgent,
  ProjectedRun,
  ProjectedTeamNote,
} from "@agentcore/protocol-conformance";
import { useEffect, useState } from "react";

type ToolStepData = Extract<ProcessStep, { kind: "tool" }>;

export interface TeamProjection {
  agents: ProjectedAgent[];
  runs: ProjectedRun[];
  progress: { completed: number; total: number };
  /** 团队便签墙 (§2.2 通): notes workers broadcast to their concurrent siblings this turn
   *  (`team_note_posted`), in post order — rendered by {@link TeamView}. Optional so the promo
   *  still (which builds team from a truncated vector) and legacy callers keep compiling. */
  teamNotes?: ProjectedTeamNote[];
  /** 阻塞式求决策 (②): forwarded straight to {@link TeamView} via the `{...team}` spread so a
   *  worker's pending escalation can render as an actionable answer card. All optional — a
   *  read-only / history team simply omits them. */
  conversationId?: string | null;
  /** runId → pending `escalation_id` (transport-only sibling extractPendingEscalations). */
  pendingEscalations?: Map<string, string>;
  /** Live turn → the pending escalation is answerable over the open stream. */
  escalationsInteractive?: boolean;
  /** 队员工具明细 (RunDetail · 工具调用): runId → the worker's tool calls, from the transport-only
   *  sibling {@link import("@/protocol/fold").extractRunToolCalls} (the fold drops run-scoped tool
   *  IO, so the run-detail panel reads it from here). Absent → the panel shows no tool section. */
  runToolCalls?: Map<string, RunToolCall[]>;
  /** Worker `tool_use_progress` (run_id): runId → live EXECUTION phase (transport-only sibling
   *  {@link import("@/protocol/fold").extractWorkerToolPhases}). */
  workerToolPhases?: Map<string, { phase: string; toolName: string }>;
}

export function AssistantContent({
  process,
  content,
  reasoning,
  citations,
  captainContext,
  team,
  debate,
  debateRounds,
  asks,
  toolPhases,
  onFill,
}: {
  process?: ProcessStep[];
  content: string;
  reasoning?: string;
  citations?: Citation[];
  /** 收到的上下文 · CEO 侧 (上下文传递可视化 通道①): what the CEO captain actually read this
   *  turn (系统提示 / 对话历史 / 原始请求), rendered turn-level on its bubble — present even on a
   *  pure-chat turn (no team). */
  captainContext?: ContextBlockWire[];
  team?: TeamProjection;
  debate?: DebateResultPayload | null;
  /** 辩论进行中的逐轮叙事 (fold 的 `debateRounds`)：`debate` 收场产物未到时实时叠出主持人逐
   *  轮焦点 / 小结 / 裁判；收场后让位给 {@link DebateView} 的全量双产物。 */
  debateRounds?: DebateNarrativeRound[];
  /** 非阻塞提问 (ask_user blocking=false): transport-only card content keyed by ask_id,
   *  read off raw events via {@link extractAsks} (NOT the ProjectedTurn). The timeline's
   *  `ask` marker resolves to its card here; empty/absent → the marker no-ops. */
  asks?: NonBlockingAsk[];
  /** 工具执行阶段进度 (联网搜索前端展示优化): tool_call_id → latest coarse phase for a still-running
   *  tool, from the transport-only live sibling {@link extractToolPhases}. Live turns only; absent
   *  on history replay (the events are never journaled) → tool rows show plain status. */
  toolPhases?: Map<string, ToolPhase>;
  /** Tap an ask/chip → fill the composer (回填输入框, review before send). Absent → chips
   *  render but no-op (e.g. a read-only context with no composer). */
  onFill?: (text: string) => void;
}) {
  const hasTeam = !!team && team.runs.length > 0;
  return (
    <>
      {debate ? (
        <DebateView debate={debate} />
      ) : debateRounds && debateRounds.length > 0 ? (
        <LiveDebateNarrative rounds={debateRounds} />
      ) : null}
      {process && process.length > 0 ? (
        // 统一团队时间线: the team graph rides its inline `team` marker (协作图时间线落点);
        // the checkpoint·ask·plan_review markers are anchors for desktop cards — mobile owns
        // those via its PauseCard, so they no-op inline here.
        <ProcessTimeline
          steps={process}
          citations={citations}
          team={hasTeam ? team : undefined}
          asks={asks}
          toolPhases={toolPhases}
          onFill={onFill}
        />
      ) : (
        <>
          {hasTeam ? <TeamView {...team} /> : null}
          {reasoning ? <Reasoning text={reasoning} /> : null}
          {content ? (
            <Markdown content={content} citations={citations} />
          ) : null}
        </>
      )}
      {captainContext && captainContext.length > 0 ? (
        <ReceivedContext blocks={captainContext} />
      ) : null}
      {citations && citations.length > 0 ? (
        <Citations items={citations} />
      ) : null}
    </>
  );
}

/** 收到的上下文 · CEO 侧 (上下文传递可视化 通道①): the structured context the CEO captain was
 *  fed this turn (系统提示 / 对话历史 / 原始请求), shown turn-level on its bubble. Collapsible
 *  like 思考 (secondary to the answer). 决策②: the `system` block (verbatim 系统提示) is hidden
 *  — mobile has no 用量明细 reveal, so the full prompt stays a desktop power-user surface. */
function ReceivedContext({ blocks }: { blocks: ContextBlockWire[] }) {
  const visible = blocks.filter((b) => b.channel !== "system");
  if (visible.length === 0) return null;
  return (
    <details className="recv">
      <summary>收到的上下文 · {visible.length} 段</summary>
      <div className="recv-list">
        {visible.map((b, i) => (
          <div key={`${b.channel}-${i}`} className="recv-item">
            <div className="recv-head">
              <span className="recv-channel">
                {CONTEXT_CHANNEL_LABEL[b.channel] ?? b.channel}
              </span>
              {b.heading && <span className="recv-heading">{b.heading}</span>}
            </div>
            {b.body && <pre className="recv-body">{b.body}</pre>}
            {b.files.length > 0 && (
              <div className="recv-files">
                {b.files.map((f) => (
                  <span key={f} className="recv-file">
                    {f}
                  </span>
                ))}
              </div>
            )}
            {b.truncated && (
              <div className="recv-trunc">已截断（完整内容已传给 AI）</div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/** 工具执行阶段进度 → 等待态文案 (联网前端展示优化): a running tool's coarse phase (from a
 *  transport-only `tool_use_progress` event, read live via extractToolPhases) as user-facing
 *  text — so a waiting slow tool reads「正在检索 / 正在抓取网页 / 正在执行」rather than a bare
 *「进行中」. Mirrors the desktop labels (各端全新建; chrome, not shared logic). Unknown phase →
 *  generic「处理中」. */
const TOOL_PHASE_TEXT: Record<ToolPhase, string> = {
  queued: "排队中",
  querying: "正在检索",
  fallback: "改用备用引擎",
  fetching: "正在抓取网页",
  reading: "正在提取正文",
  executing: "正在执行",
  blocked: "出网受限",
};
const toolPhaseText = (phase: ToolPhase | undefined): string | null =>
  phase ? (TOOL_PHASE_TEXT[phase] ?? "处理中") : null;

/** Seconds a tool has been running, ticking client-side from when this row first saw `running`
 *  (≈ the tool_use_start instant) — a liveliness cue for a BLOCKING tool (web_search) whose
 *  execution streams no incremental progress. Resets when not running. Mirrors desktop. */
function useRunningElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [running]);
  return elapsed;
}

/** Last path segment of a detail (a file 名 from a path / url); the whole string when it
 *  carries no separator (a query / pattern). Keeps a group summary compact. */
function baseName(detail: string): string {
  if (!detail) return "";
  const segs = detail.split(/[/\\]/);
  return segs[segs.length - 1] || detail;
}

type TimelineNode =
  | Exclude<ProcessStep, { kind: "tool" }>
  | { kind: "tool"; step: ToolStepData }
  | { kind: "tool-group"; tools: ToolStepData[] };

/** Coalesce consecutive tool steps into collapsible groups (前端UX设计.md §一B): a run of
 *  ≥2 adjacent tool steps folds into one `tool-group`, a lone tool stays inline, and
 *  reasoning/content break runs so chronological order is preserved. Mobile keeps its own
 *  copy of this fold — it is chrome, not a protocol fold (no conformance), so the desktop
 *  `groupToolRuns` is intentionally NOT imported (各端全新建 per cross-platform-frontend). */
function groupToolRuns(steps: ProcessStep[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  let run: ToolStepData[] = [];
  const flush = () => {
    if (run.length === 0) return;
    nodes.push(
      run.length === 1
        ? { kind: "tool", step: run[0] }
        : { kind: "tool-group", tools: run },
    );
    run = [];
  };
  for (const s of steps) {
    if (s.kind === "tool") run.push(s);
    else {
      flush();
      nodes.push(s);
    }
  }
  flush();
  return nodes;
}

/** Header summary for a folded tool group: per-category counts in first-seen order
 *  (「读取文件 6 · 编辑文件 2」), or each call's 名/查询 when a single-category run is ≤3. */
function toolGroupSummary(tools: ToolStepData[]): string {
  const sameKind = tools.every((t) => t.tool_name === tools[0].tool_name);
  if (sameKind && tools.length <= 3) {
    const label = toolLabel(tools[0].tool_name);
    const names = tools.map((t) => baseName(toolDetail(t.arguments)));
    if (names.every(Boolean)) return `${label} ${names.join(" · ")}`;
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const label = toolLabel(t.tool_name);
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order.map((l) => `${l} ${counts.get(l)}`).join(" · ");
}

/** The single-agent inline timeline: content (Markdown), thinking (collapsible), and tool
 *  calls, in the order the model produced them. Consecutive tools coalesce into a
 *  collapsible {@link ToolGroup} (≥2); a lone tool stays an inline {@link ToolStep}.
 *  Append-only, so index keys are stable; the last content/reasoning text grows in place
 *  while streaming. */
function ProcessTimeline({
  steps,
  citations,
  team,
  asks,
  toolPhases,
  onFill,
}: {
  steps: ProcessStep[];
  citations?: Citation[];
  team?: TeamProjection;
  asks?: NonBlockingAsk[];
  toolPhases?: Map<string, ToolPhase>;
  onFill?: (text: string) => void;
}) {
  const nodes = groupToolRuns(steps);
  // Legacy turns whose persisted process predates the `team` marker still carry a team
  // (re-folded from events) — render it once at the top so the graph never vanishes.
  const hasTeamMarker = steps.some((s) => s.kind === "team");
  return (
    <div className="timeline">
      {team && !hasTeamMarker ? <TeamView {...team} /> : null}
      {nodes.map((node, i) => {
        if (node.kind === "content")
          // biome-ignore lint/suspicious/noArrayIndexKey: timeline is an append-only stream; segments never reorder, so the index is stable identity
          return <Markdown key={i} content={node.text} citations={citations} />;
        if (node.kind === "reasoning")
          // biome-ignore lint/suspicious/noArrayIndexKey: timeline is an append-only stream; segments never reorder, so the index is stable identity
          return <Reasoning key={i} text={node.text} />;
        if (node.kind === "team")
          return team ? (
            <TeamView key={`team-${node.execution_id}`} {...team} />
          ) : null;
        // 非阻塞提问卡 (ask_user blocking=false): resolve the `ask` marker to its card at
        // its chronological slot, content looked up by ask_id from the transport-only
        // `asks` side channel (extractAsks). No content (single-agent history / no onFill)
        // → the marker no-ops, exactly like desktop.
        if (node.kind === "ask") {
          const ask = asks?.find((a) => a.id === node.ask_id);
          return ask && onFill ? (
            <NonBlockingAskCard key={ask.id} ask={ask} onFill={onFill} />
          ) : null;
        }
        // checkpoint·plan_review markers anchor desktop cards; mobile owns these blocking
        // interactions via its PauseCard surface, so they render nothing inline.
        if (
          node.kind === "checkpoint" ||
          node.kind === "plan_review" ||
          node.kind === "team_preview"
        )
          return null;
        if (node.kind === "tool-group")
          return (
            <ToolGroup
              key={node.tools[0].id}
              tools={node.tools}
              toolPhases={toolPhases}
            />
          );
        if (node.kind === "rework")
          return (
            <span key={`rework-${i}`} className="rework-chip">
              已按交付规范重写
            </span>
          );
        if (node.kind !== "tool") return null;
        return (
          <ToolStep
            key={node.step.id}
            step={node.step}
            phase={toolPhases?.get(node.step.id)}
          />
        );
      })}
    </div>
  );
}

/** Collapsible thinking block (collapsed by default — secondary to the answer). */
function Reasoning({ text }: { text: string }) {
  return (
    <details className="reasoning">
      <summary>思考</summary>
      <Markdown content={text} muted />
    </details>
  );
}

/** A folded run of ≥2 consecutive tool calls (前端UX设计.md §一B; the mobile mirror of the
 *  desktop ProcessToolGroup). A collapsed-by-default <details> — the same fold idiom as 思考
 *  (mobile has no streaming-aware auto-expand for either) — whose summary is the per-category
 *  count / file names plus any 失败 count; expands to the unchanged per-tool {@link ToolStep}
 *  rows, each still openable to its own result. */
function ToolGroup({
  tools,
  toolPhases,
}: {
  tools: ToolStepData[];
  toolPhases?: Map<string, ToolPhase>;
}) {
  const errorCount = tools.reduce(
    (n, t) => n + (t.status === "error" ? 1 : 0),
    0,
  );
  return (
    <details className="tool-group">
      <summary>
        <span className="tool-group-summary">{toolGroupSummary(tools)}</span>
        {errorCount > 0 && (
          <span className="tool-group-error">{errorCount} 个失败</span>
        )}
      </summary>
      <div className="tool-group-body">
        {tools.map((t) => (
          <ToolStep key={t.id} step={t} phase={toolPhases?.get(t.id)} />
        ))}
      </div>
    </details>
  );
}

const TOOL_STATUS: Record<ToolStepData["status"], string> = {
  running: "进行中",
  success: "完成",
  error: "失败",
};

/** A tool call: 中文名 (+ its 参数 detail) · status, expandable to its full arguments and
 *  result. While running, the status shows the coarse 执行阶段 (正在检索 / 排队中 / 改用备用引擎,
 *  from the live `phase`) + an elapsed timer — a live waiting cue instead of a static「进行中」. */
function ToolStep({
  step,
  phase,
}: {
  step: ToolStepData;
  phase?: ToolPhase;
}) {
  const [open, setOpen] = useState(false);
  const args = Object.keys(step.arguments).length > 0 ? step.arguments : null;
  const detail = toolDetail(step.arguments);
  const running = step.status === "running";
  const elapsed = useRunningElapsed(running);
  const runningStatus = running
    ? [
        toolPhaseText(phase) ?? TOOL_STATUS.running,
        elapsed >= 1 ? `${elapsed}s` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : TOOL_STATUS[step.status];
  return (
    <div className={`tool tool-${step.status}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tool-name">
          {toolLabel(step.tool_name)}
          {detail && <span className="tool-detail">{detail}</span>}
        </span>
        <span className="tool-status">{runningStatus}</span>
      </button>
      {open && (args || step.result != null) && (
        <div className="tool-body">
          {args && (
            <pre className="tool-pre">{JSON.stringify(args, null, 2)}</pre>
          )}
          {step.result != null && step.result !== "" && (
            <pre className="tool-pre">{step.result}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** The web sources consulted for this message (citations event / persisted citations). */
function Citations({ items }: { items: Citation[] }) {
  return (
    <div className="cites">
      <div className="cites-title">来源</div>
      {items.map((c, i) => (
        <a
          key={`${c.url}-${i}`}
          className="cite"
          href={c.url}
          target="_blank"
          rel="noreferrer"
        >
          <span className="cite-n">{i + 1}</span>
          <span className="cite-text">
            <span className="cite-title">{c.title || c.url}</span>
            {c.site && <span className="cite-site">{c.site}</span>}
          </span>
        </a>
      ))}
    </div>
  );
}
