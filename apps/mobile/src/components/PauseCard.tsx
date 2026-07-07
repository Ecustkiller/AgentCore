import {
  type ResolveInteractionBody,
  resolveInteraction,
} from "@/api/interaction";
// The interactive pause card — the actionable surface for a turn blocked on the user
// (前端技术与架构 §七 · 交互式暂停放行). The conformance-checked fold computes
// `pendingInteraction`; this turns it into buttons that POST the decision to the live
// stream (api/interaction.ts), which resumes the SAME SSE. Rendered above the composer so
// it stays visible while the turn is blocked.
//
// 挂起即收口 (②, Phase 3): only an `approval` still resolves live in-stream. A CEO checkpoint
// (ask_user) / plan_review no longer parks live — it finalizes the turn (message_end
// finish_reason=paused) and is continued via the durable ResumeCard (the single cold resume
// path), so this card handles approvals only.
//
// This is mobile's own UI (cross-platform-frontend.mdc: zero shared business components) —
// it consumes the shared ProjectedTurn shape but renders nothing the fold doesn't carry.
import type { ApprovalDecision } from "@agentcore/contract-types";
import type { PendingInteraction } from "@agentcore/protocol-conformance";
import { type ReactNode, useState } from "react";

/** Friendly zh labels for the GRANTABLE built-ins; falls back to the raw name. */
const TOOL_LABELS: Record<string, string> = {
  file_write: "写入文件",
  file_append: "追加文件",
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
  "file_append",
  "str_replace",
  "file_delete",
  "file_move",
]);

/** Tools confirmed PER CALL — their card omits「本轮都允许」(approve_always), mirroring
 *  the backend per_call_tool_names() (GRANTABLE ∩ EXECUTION). code_execute re-prompts
 *  every call so a later injected-content-driven execution can't ride an earlier
 *  turn-grant (PI-004). The backend gate is authoritative (it downgrades approve_always
 *  on these to a one-shot approve); this just hides the button. */
const PER_CALL_TOOLS: ReadonlySet<string> = new Set(["code_execute"]);

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
  onResolved,
}: {
  pending: Extract<PendingInteraction, { kind: "approval" }>;
  conversationId: string;
  /** Invoked after a successful resolve (used when the card was rehydrated from recovery). */
  onResolved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(body: ResolveInteractionBody) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await resolveInteraction(conversationId, pending.approvalId, body);
      onResolved?.();
      // Leave busy=true on success: the stream's approval_resolved event drops `pending`
      // and unmounts this card. A stale 404 is swallowed too — the turn has moved on.
    } catch (e) {
      setErr(e instanceof Error ? e.message : "放行失败");
      setBusy(false);
    }
  }

  return (
    <div className="pause">
      <ApprovalBody
        pending={pending}
        busy={busy}
        onDecide={(decision) => void submit({ kind: "approval", decision })}
      />
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
        {!PER_CALL_TOOLS.has(pending.toolName) && (
          <Btn
            tone="neutral"
            disabled={busy}
            onClick={() => onDecide("approve_always")}
          >
            本轮都允许
          </Btn>
        )}
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
