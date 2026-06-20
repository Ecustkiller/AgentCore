// The multi-agent team view for the mobile client (手机端落地设计 P1 · 多 Agent 团队视图).
//
// A mobile-native, VERTICAL reduction of the desktop React-Flow team graph
// (InlineTeamGraph / GraphView): the same ProjectedTurn.{agents, runs, progress} fields,
// no canvas / ELK / scrubber. Consumed IDENTICALLY by live turns (fold(turn.events)) and
// history replay (fold(MessageDetail.runs.events)) — there is no second data path.
//
// The `captain` run is the chat bubble itself (the CEO's reply streams into the message),
// so it is omitted here; only the delegated `agent` workers are listed. The three desktop
// relations collapse to mobile-appropriate cues: DAG order = list order, the delegate tree
// (`parentRunId`) = indentation, the revision chain (`revision >= 2`) = a badge. Debate
// (`stance`) shows a pill per card rather than pro/con columns (too wide for a phone).
import type {
  ProjectedAgent,
  ProjectedRun,
  RunStatus,
} from "@agentcore/protocol-conformance";

type CheckpointDecision = NonNullable<ProjectedRun["checkpoint"]>["decision"];

const RUN_STATUS: Record<RunStatus, { label: string; tone: string }> = {
  pending: { label: "等待", tone: "muted" },
  ready: { label: "就绪", tone: "muted" },
  running: { label: "进行中", tone: "run" },
  completed: { label: "完成", tone: "ok" },
  failed: { label: "失败", tone: "err" },
  cancelled: { label: "已取消", tone: "muted" },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function checkpointLabel(decision: CheckpointDecision): string {
  switch (decision) {
    case "adjust":
      return "已调整";
    case "stop":
      return "已停止";
    case "timeout":
      return "已超时";
    default:
      return "已放行";
  }
}

function lastLine(text: string | undefined): string | null {
  if (!text) return null;
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1] || null;
}

export function TeamView({
  agents,
  runs,
  progress,
}: {
  agents: ProjectedAgent[];
  runs: ProjectedRun[];
  progress: { completed: number; total: number };
}) {
  const workers = runs.filter((r) => r.kind !== "captain");
  if (workers.length === 0) return null;

  const isDebate = workers.some((r) => r.stance);
  const pct =
    progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;

  // Indent a nested delegate by how many worker parents it chains through (stage-2 子任务).
  const depthOf = (run: ProjectedRun): number => {
    let depth = 0;
    let parentId = run.parentRunId;
    const seen = new Set<string>([run.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = workers.find((r) => r.id === parentId);
      if (!parent) break;
      depth += 1;
      parentId = parent.parentRunId;
    }
    return depth;
  };

  return (
    <div className="team">
      <div className="team-head">
        <span className="team-count">
          团队 {progress.completed}/{progress.total}
        </span>
        {isDebate && <span className="team-tag">辩论</span>}
      </div>
      <div className="team-bar">
        <span className="team-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="team-runs">
        {workers.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            agent={agents.find((a) => a.id === run.agentId)}
            depth={depthOf(run)}
          />
        ))}
      </div>
    </div>
  );
}

function RunCard({
  run,
  agent,
  depth,
}: {
  run: ProjectedRun;
  agent: ProjectedAgent | undefined;
  depth: number;
}) {
  const st = RUN_STATUS[run.status];
  const name = run.role ?? agent?.role ?? run.agentId;
  // Running: the worker's streaming tail (tool call > output last line). Settled: its
  // one-line summary. Both come off the same fold whether live or replayed.
  const preview =
    run.status === "running"
      ? agent?.toolProgress
        ? `调用 ${agent.toolProgress.toolName}…`
        : lastLine(agent?.output)
      : run.outputSummary;

  return (
    <div
      className={`run run-${st.tone}`}
      style={depth > 0 ? { marginInlineStart: depth * 12 } : undefined}
    >
      <div className="run-head">
        <span className="run-name">{name}</span>
        <span className={`run-badge badge-${st.tone}`}>{st.label}</span>
      </div>
      {(run.stance ||
        run.revision >= 2 ||
        depth > 0 ||
        run.checkpoint ||
        run.escalations.length > 0) && (
        <div className="run-tags">
          {run.stance && (
            <span className="run-pill">
              {run.stance === "pro" ? "正方" : "反方"}
            </span>
          )}
          {run.revision >= 2 && (
            <span className="run-pill">修订 v{run.revision}</span>
          )}
          {depth > 0 && <span className="run-pill">子任务</span>}
          {run.checkpoint && (
            <span className="run-pill pill-warn">
              {run.checkpoint.status === "pending"
                ? "待放行"
                : checkpointLabel(run.checkpoint.decision)}
            </span>
          )}
          {/* 升级实时可见: a worker flagged a blocker for the CEO — a 待裁决 cue mirroring
              the desktop node ⚠️ badge; the full ask renders below. */}
          {run.escalations.length > 0 && (
            <span className="run-pill pill-warn">
              上报
              {run.escalations.length > 1 ? ` ${run.escalations.length}` : ""}
            </span>
          )}
        </div>
      )}
      {run.task && <div className="run-task">{run.task}</div>}
      {/* 升级实时可见: the worker's 向上求决策 — its self-contained 问题 + the 假设 it
          proceeded on (escalate 非阻塞). Surfaced inline so the user sees a flagged
          blocker without drilling into the worker's timeline. */}
      {run.escalations.map((esc, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: per-run escalations are append-only with stable order, so the index is a stable identity here
        <div key={i} className="run-escalation">
          <span className="run-escalation-q">↑ {esc.question}</span>
          {esc.assumption && (
            <span className="run-escalation-a">暂用假设：{esc.assumption}</span>
          )}
        </div>
      ))}
      {preview && <div className="run-preview">{preview}</div>}
      {run.error && <div className="run-error">{run.error}</div>}
      {run.status === "completed" && run.durationMs != null && (
        <div className="run-foot">{formatDuration(run.durationMs)}</div>
      )}
    </div>
  );
}
