// The interactive pause card — the actionable surface for a turn blocked on the user
// (手机端落地设计 P1 · 交互式暂停放行). The conformance-checked fold computes
// `pendingInteraction`; this turns it into buttons that POST the decision to the live
// stream (api/interaction.ts), which resumes the SAME SSE. Rendered above the composer so
// it stays visible while the turn is blocked.
//
// This is mobile's own UI (cross-platform-frontend.mdc: zero shared business components) —
// it consumes the shared ProjectedTurn shape but renders nothing the fold doesn't already
// carry. A checkpoint's structured questions/options are deliberately NOT rendered: the
// fold's `checkpoint` pending carries only `question`/`context` (the ProjectedTurn golden),
// so the answer is a free-text note (the CEO reads prose anyway — ask_user_tool_result).
import type {
  ApprovalDecision,
  CheckpointDecision,
} from "@agentcore/contract-types";
import type {
  PendingInteraction,
  ProjectedRun,
} from "@agentcore/protocol-conformance";
import { type ReactNode, useState } from "react";
import {
  type ResolveInteractionBody,
  resolveInteraction,
} from "@/api/interaction";

/** Friendly zh labels for the GRANTABLE built-ins; falls back to the raw name. */
const TOOL_LABELS: Record<string, string> = {
  file_write: "写入文件",
  str_replace: "修改文件",
  file_delete: "删除文件",
  file_move: "移动文件",
  code_execute: "执行代码",
};

/** The file-mutation tool class the「本轮内所有文件改动」grant covers, mirroring the
 *  backend file_mutation_tool_names() (GRANTABLE ∩ FILESYSTEM). code_execute is excluded —
 *  it keeps its own per-tool gate. The backend gate is authoritative; this only decides
 *  whether to offer the class button. */
const FILE_OP_TOOLS: ReadonlySet<string> = new Set([
  "file_write",
  "str_replace",
  "file_delete",
  "file_move",
]);

/** The single argument worth headlining on an approval card, if recognisable. */
function primaryArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "command", "code"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function PauseCard({
  pending,
  conversationId,
  runs,
}: {
  pending: PendingInteraction;
  conversationId: string;
  runs: ProjectedRun[];
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const interactionId =
    pending.kind === "approval" ? pending.approvalId : pending.checkpointId;

  async function submit(body: ResolveInteractionBody) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await resolveInteraction(conversationId, interactionId, body);
      // Leave busy=true on success: the stream's *_resolved event drops `pending` and
      // unmounts this card. A stale 404 is swallowed too — the turn has moved on.
    } catch (e) {
      setErr(e instanceof Error ? e.message : "放行失败");
      setBusy(false);
    }
  }

  return (
    <div className="pause">
      {pending.kind === "approval" && (
        <ApprovalBody
          pending={pending}
          busy={busy}
          onDecide={(decision) => void submit({ kind: "approval", decision })}
        />
      )}
      {pending.kind === "checkpoint" && (
        <CheckpointBody
          pending={pending}
          note={note}
          setNote={setNote}
          busy={busy}
          onSubmit={(decision) =>
            void submit({
              kind: "ask_user",
              decision,
              note: note.trim(),
              selected: [],
            })
          }
        />
      )}
      {pending.kind === "plan_review" && (
        <PlanReviewBody
          pending={pending}
          runs={runs}
          note={note}
          setNote={setNote}
          busy={busy}
          onSubmit={(decision) =>
            void submit({ kind: "plan_review", decision, note: note.trim() })
          }
        />
      )}
      {busy && <div className="pause-busy">处理中…</div>}
      {err && <div className="error pause-err">{err}</div>}
    </div>
  );
}

function ApprovalBody({
  pending,
  busy,
  onDecide,
}: {
  pending: Extract<PendingInteraction, { kind: "approval" }>;
  busy: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const headline = primaryArg(pending.arguments);
  const label = TOOL_LABELS[pending.toolName] ?? pending.toolName;
  return (
    <>
      <div className="pause-title">Agent 请求执行 · {label}</div>
      {headline && <div className="pause-arg">{headline}</div>}
      <div className="pause-actions">
        <Btn tone="primary" disabled={busy} onClick={() => onDecide("approve")}>
          允许一次
        </Btn>
        <Btn
          tone="neutral"
          disabled={busy}
          onClick={() => onDecide("approve_always")}
        >
          本轮都允许
        </Btn>
        {FILE_OP_TOOLS.has(pending.toolName) && (
          <Btn
            tone="neutral"
            disabled={busy}
            onClick={() => onDecide("approve_always_files")}
          >
            本轮内所有文件改动
          </Btn>
        )}
        <Btn tone="danger" disabled={busy} onClick={() => onDecide("deny")}>
          拒绝
        </Btn>
      </div>
    </>
  );
}

function CheckpointBody({
  pending,
  note,
  setNote,
  busy,
  onSubmit,
}: {
  pending: Extract<PendingInteraction, { kind: "checkpoint" }>;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onSubmit: (decision: CheckpointDecision) => void;
}) {
  return (
    <>
      <div className="pause-title">需要你拍板</div>
      <div className="pause-question">{pending.question}</div>
      {pending.context && <div className="pause-context">{pending.context}</div>}
      <textarea
        className="pause-note"
        rows={2}
        value={note}
        disabled={busy}
        placeholder="可选 · 你的答复或补充，留空则按上面继续"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="pause-actions">
        <Btn tone="primary" disabled={busy} onClick={() => onSubmit("continue")}>
          继续
        </Btn>
        <Btn tone="danger" disabled={busy} onClick={() => onSubmit("stop")}>
          停止
        </Btn>
      </div>
    </>
  );
}

function PlanReviewBody({
  pending,
  runs,
  note,
  setNote,
  busy,
  onSubmit,
}: {
  pending: Extract<PendingInteraction, { kind: "plan_review" }>;
  runs: ProjectedRun[];
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onSubmit: (decision: CheckpointDecision) => void;
}) {
  const reviewed = pending.runIds
    .map((id) => runs.find((r) => r.id === id))
    .filter((r): r is ProjectedRun => r != null);
  return (
    <>
      <div className="pause-title">执行已暂停 · 待你决定是否继续</div>
      {reviewed.length > 0 && (
        <div className="pause-steps">
          {reviewed.map((r) => (
            <div key={r.id} className="pause-step">
              <div className="pause-step-role">{r.role ?? r.task}</div>
              {r.outputSummary && (
                <div className="pause-step-summary">{r.outputSummary}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <textarea
        className="pause-note"
        rows={2}
        value={note}
        disabled={busy}
        placeholder="可选 · 调整时作为对下游的指示；停止时作为收尾备注"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="pause-actions">
        <Btn tone="primary" disabled={busy} onClick={() => onSubmit("continue")}>
          继续
        </Btn>
        <Btn
          tone="neutral"
          disabled={busy || !note.trim()}
          onClick={() => onSubmit("adjust")}
        >
          调整
        </Btn>
        <Btn tone="danger" disabled={busy} onClick={() => onSubmit("stop")}>
          停止
        </Btn>
      </div>
    </>
  );
}

function Btn({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: "primary" | "neutral" | "danger";
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`pause-btn pause-btn-${tone}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
