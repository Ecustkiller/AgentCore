// The multi-agent team view for the mobile client (前端技术与架构 §七 · 多 Agent 团队视图).
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
import {
  type EscalationUserDecision,
  decideEscalation,
} from "@/api/interaction";
import type {
  ProjectedAgent,
  ProjectedRun,
  ProjectedTeamNote,
  RunEscalation,
  RunStatus,
} from "@agentcore/protocol-conformance";
import { useState } from "react";

type CheckpointDecision = NonNullable<ProjectedRun["checkpoint"]>["decision"];

/** 团队便签墙 (§2.2 通) note kind → 中文 label + css class. `decision` (我定了) is a choice others
 * depend on (an interface / field name / format / naming); `heads_up` (提个醒) is a pitfall /
 * discovery; `claim` (我领了) is a piece of work / file this worker is taking, so a sibling doesn't
 * duplicate it. Mirrors the backend NoteWall labels (runtime/runs/notewall.py); an unknown kind
 * falls back to 提个醒. */
const NOTE_STATUS_LABEL: Record<string, string> = {
  superseded: "已更新",
  voided: "已作废",
};

const NOTE_KIND_LABEL: Record<string, string> = {
  decision: "我定了",
  heads_up: "提个醒",
  claim: "我领了",
};

const NOTE_KIND_CLASS: Record<string, string> = {
  decision: "kind-decision",
  heads_up: "kind-headsup",
  claim: "kind-claim",
};

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

/** The read-only one-liner under an escalation's question, by lifecycle: 已答复 carries the
 *  user's answer; 已超时/非阻塞上报/待裁决(非交互) fall back to the worker's 假设. */
function escalationDetail(esc: RunEscalation): string | null {
  if (esc.status === "resolved" && esc.answer) return `已答复：${esc.answer}`;
  if (esc.status === "timeout")
    return esc.assumption ? `已按假设继续：${esc.assumption}` : null;
  return esc.assumption ? `暂用假设：${esc.assumption}` : null;
}

export function TeamView({
  agents,
  runs,
  progress,
  teamNotes = [],
  conversationId = null,
  pendingEscalations,
  escalationsInteractive = false,
}: {
  agents: ProjectedAgent[];
  runs: ProjectedRun[];
  progress: { completed: number; total: number };
  /** 团队便签墙 (§2.2 通): notes workers broadcast to their concurrent siblings this turn. */
  teamNotes?: ProjectedTeamNote[];
  /** 阻塞式求决策 (②): present on a live multi-agent turn so a worker's pending escalation
   *  renders as an actionable answer card. */
  conversationId?: string | null;
  /** runId → pending `escalation_id` (transport-only sibling extractPendingEscalations); the
   *  resolve key the conformance RunEscalation deliberately omits. */
  pendingEscalations?: Map<string, string>;
  /** Live turn → the pending escalation is answerable over the open stream (else read-only). */
  escalationsInteractive?: boolean;
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
            conversationId={conversationId}
            pendingEscalationId={
              escalationsInteractive
                ? pendingEscalations?.get(run.id)
                : undefined
            }
          />
        ))}
      </div>
      {/* 团队便签墙 (§2.2 通): the one-line decisions / heads-ups workers broadcast to their
          concurrent siblings this turn — the visible, glass-box face of the note wall (贴事实·
          不要求回应, NOT a chat). Shown attributed (谁贴的) + kind-tagged (我定了 / 提个醒), in post
          order. Empty (the common case) renders nothing. */}
      {teamNotes.length > 0 && (
        <div className="team-notes">
          <div className="team-notes-head">团队便签 {teamNotes.length}</div>
          {teamNotes.map((note) => {
            // 便签会过期 → supersession (§2.2): a 改写/作废'd note is struck + dimmed with a status
            // pill, so a stale decision can't be mistaken for current truth. `active` → no pill.
            const statusLabel = NOTE_STATUS_LABEL[note.status];
            return (
              <div
                key={note.noteId}
                className={`team-note${statusLabel ? " team-note-stale" : ""}`}
              >
                <div className="team-note-meta">
                  <span
                    className={`team-note-kind ${
                      NOTE_KIND_CLASS[note.kind] ?? "kind-headsup"
                    }`}
                  >
                    {NOTE_KIND_LABEL[note.kind] ?? "提个醒"}
                  </span>
                  <span className="team-note-author">
                    {note.role || note.agentId}
                  </span>
                  {statusLabel && (
                    <span
                      className={`team-note-status ${
                        note.status === "voided"
                          ? "status-voided"
                          : "status-superseded"
                      }`}
                    >
                      {statusLabel}
                    </span>
                  )}
                </div>
                <div className="team-note-text">{note.text}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run,
  agent,
  depth,
  conversationId,
  pendingEscalationId,
}: {
  run: ProjectedRun;
  agent: ProjectedAgent | undefined;
  depth: number;
  conversationId: string | null;
  /** The run's pending blocking escalation id (set only on a live turn) → answer card. */
  pendingEscalationId: string | undefined;
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
        run.revised ||
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
          {/* 「计划已调整」轻痕迹 (设计 §7.2): the CEO autonomously re-bound (bind) /
              re-steered (steer) this node mid-flight — a non-interrupting cue mirroring
              the desktop node badge. */}
          {run.revised && <span className="run-pill">计划已调整</span>}
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
      {/* 升级实时可见 / 阻塞式求决策: the worker's 向上求决策 — its self-contained 问题 + the
          假设 it proceeds on. A blocking escalate awaiting the user on a LIVE turn becomes an
          actionable answer card (待你拍板); every other state (非阻塞上报 / 已答复 / 已超时 /
          history) stays a read-only inline notice. */}
      {run.escalations.map((esc, i) => {
        const liveId =
          esc.status === "pending" && conversationId
            ? pendingEscalationId
            : undefined;
        if (liveId && conversationId) {
          return (
            <EscalationAnswer
              // biome-ignore lint/suspicious/noArrayIndexKey: per-run escalations are append-only with stable order, so the index is a stable identity here
              key={i}
              esc={esc}
              escalationId={liveId}
              conversationId={conversationId}
            />
          );
        }
        const detail = escalationDetail(esc);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: per-run escalations are append-only with stable order, so the index is a stable identity here
          <div key={i} className="run-escalation">
            <span className="run-escalation-q">↑ {esc.question}</span>
            {detail && <span className="run-escalation-a">{detail}</span>}
          </div>
        );
      })}
      {preview && <div className="run-preview">{preview}</div>}
      {run.error && <div className="run-error">{run.error}</div>}
      {run.status === "completed" && run.durationMs != null && (
        <div className="run-foot">{formatDuration(run.durationMs)}</div>
      )}
    </div>
  );
}

/** 阻塞式求决策「待你拍板」(②): a worker SUSPENDED on a blocking escalate is awaiting the user
 *  over the open stream. Free-text answer + 提交 / 按假设继续 (== timeout disposition), mirroring
 *  the mobile PauseCard's reduced surface (structured forks fold to prose). decideEscalation
 *  POSTs to the unified resolve endpoint; the stream's `escalation_resolved` then folds this
 *  run's escalation to resolved/timeout and unmounts the card (so busy stays true on success). */
function EscalationAnswer({
  esc,
  escalationId,
  conversationId,
}: {
  esc: RunEscalation;
  escalationId: string;
  conversationId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function decide(decision: EscalationUserDecision) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await decideEscalation(conversationId, escalationId, decision);
      // Leave busy=true on success: escalation_resolved drops `pending` and unmounts this.
    } catch (e) {
      setErr(e instanceof Error ? e.message : "提交失败");
      setBusy(false);
    }
  }

  return (
    <div className="run-escalation run-escalation-live">
      <span className="run-escalation-q">↑ {esc.question}</span>
      {esc.assumption && (
        <span className="run-escalation-a">
          未答则按此继续：{esc.assumption}
        </span>
      )}
      <textarea
        className="run-escalation-note"
        rows={2}
        value={note}
        disabled={busy}
        placeholder="输入你的决定（留空则点「按假设继续」）"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="run-escalation-actions">
        <button
          type="button"
          className="esc-btn esc-btn-primary"
          disabled={busy || !note.trim()}
          onClick={() => void decide({ kind: "answer", answer: note.trim() })}
        >
          提交
        </button>
        <button
          type="button"
          className="esc-btn esc-btn-neutral"
          disabled={busy}
          onClick={() => void decide({ kind: "use_assumption" })}
        >
          按假设继续
        </button>
      </div>
      {busy && <span className="run-escalation-busy">处理中…</span>}
      {err && <span className="run-error">{err}</span>}
    </div>
  );
}
