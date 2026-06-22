import { DebateView, LiveDebateNarrative } from "@/components/DebateView";
import { Markdown } from "@/components/Markdown";
import { TeamView } from "@/components/TeamView";
// Rich assistant rendering shared by live turns and history replay (前端技术与架构 §七 ·
// 富渲染 + 多 Agent 团队视图). One {@link AssistantContent} consumes the same fields whether
// they come from the live fold (ProjectedTurn) or a persisted message (MessageDetail):
//
//   - single-agent turn → a `process` timeline (正文 / 思考 / 工具, interleaved); for
//                          history it is restored from MessageDetail.runs.process
//   - multi-agent turn  → `process` is empty (activity lives in the `team` graph); render
//                          the team view + the captain's `content` + `reasoning`. For
//                          history the team is re-folded from MessageDetail.runs.events.
//
// Citations render as a source list under the message either way.
import type {
  Citation,
  ContextBlockWire,
  DebateNarrativeRound,
  DebateResultPayload,
  ProcessStep,
} from "@agentcore/contract-types";
import type {
  ProjectedAgent,
  ProjectedRun,
} from "@agentcore/protocol-conformance";
import { useState } from "react";

type ToolStepData = Extract<ProcessStep, { kind: "tool" }>;

export interface TeamProjection {
  agents: ProjectedAgent[];
  runs: ProjectedRun[];
  progress: { completed: number; total: number };
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
}) {
  return (
    <>
      {team && team.runs.length > 0 ? <TeamView {...team} /> : null}
      {debate ? (
        <DebateView debate={debate} />
      ) : debateRounds && debateRounds.length > 0 ? (
        <LiveDebateNarrative rounds={debateRounds} />
      ) : null}
      {process && process.length > 0 ? (
        <ProcessTimeline steps={process} citations={citations} />
      ) : (
        <>
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

/** Context channel → 中文 label (上下文传递可视化). Mirrors the desktop CONTEXT_CHANNEL_META
 *  labels so the two ends read the same (各端全新建; labels are chrome, not shared logic). */
const CONTEXT_CHANNEL_LABEL: Record<string, string> = {
  system: "系统提示",
  history: "对话历史",
  request: "原始请求",
  team_position: "团队位置",
  dependency: "前置结果",
  workspace: "工作区",
  task: "你的任务",
  expected_output: "预期产出",
  requirements: "产出要求",
  steer: "中途指示",
  team_result: "队员回传",
};

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

/** 中文工具名 — mirrors the desktop `TOOL_META` labels so the two ends read the same
 *  (各端全新建 per cross-platform-frontend; labels are chrome, not shared logic). An
 *  unknown tool falls back to its raw backend name so a newly added tool still renders. */
const TOOL_LABEL: Record<string, string> = {
  web_search: "搜索网页",
  read_url: "读取网页",
  grep: "检索代码",
  code_execute: "执行代码",
  file_read: "读取文件",
  file_write: "写入文件",
  file_list: "列出目录",
  str_replace: "编辑文件",
  file_delete: "删除文件",
  file_move: "移动文件",
  delegate: "委派任务",
  ask_user: "向你确认",
  consult_skill: "查阅能力",
  revise: "修订产物",
  escalate: "上报问题",
};
const toolLabel = (name: string): string => TOOL_LABEL[name] ?? name;

/** The most descriptive string arg to show beside a tool (its query / url / path / …);
 *  empty when the call carries no representative string arg. Mirrors desktop. */
const TOOL_DETAIL_KEYS = [
  "query",
  "url",
  "pattern",
  "path",
  "command",
  "code",
  "q",
  "text",
];
function toolDetail(args: Record<string, unknown>): string {
  for (const k of TOOL_DETAIL_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Last path segment of a detail (a file 名 from a path / url); the whole string when it
 *  carries no separator (a query / pattern). Keeps a group summary compact. */
function baseName(detail: string): string {
  if (!detail) return "";
  const segs = detail.split(/[/\\]/);
  return segs[segs.length - 1] || detail;
}

type TimelineNode =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
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
}: {
  steps: ProcessStep[];
  citations?: Citation[];
}) {
  return (
    <div className="timeline">
      {groupToolRuns(steps).map((node, i) => {
        if (node.kind === "content")
          // biome-ignore lint/suspicious/noArrayIndexKey: timeline is an append-only stream; segments never reorder, so the index is stable identity
          return <Markdown key={i} content={node.text} citations={citations} />;
        if (node.kind === "reasoning")
          // biome-ignore lint/suspicious/noArrayIndexKey: timeline is an append-only stream; segments never reorder, so the index is stable identity
          return <Reasoning key={i} text={node.text} />;
        if (node.kind === "tool-group")
          return <ToolGroup key={node.tools[0].id} tools={node.tools} />;
        return <ToolStep key={node.step.id} step={node.step} />;
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
function ToolGroup({ tools }: { tools: ToolStepData[] }) {
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
          <ToolStep key={t.id} step={t} />
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
 *  result. */
function ToolStep({ step }: { step: ToolStepData }) {
  const [open, setOpen] = useState(false);
  const args = Object.keys(step.arguments).length > 0 ? step.arguments : null;
  const detail = toolDetail(step.arguments);
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
        <span className="tool-status">{TOOL_STATUS[step.status]}</span>
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
