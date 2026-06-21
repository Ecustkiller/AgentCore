import { notifyError } from "@/lib/toast";
import {
  type EscalationUserDecision,
  decideEscalation,
} from "@/services/escalation";
import { type RunEscalation, useMessageExecution } from "@/stores/execution";
import { ArrowRight, Check, Clock, HelpCircle, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * Inline escalation card — a delegated worker hit a「只有用户能定、且猜错就作废」fork and
 * SUSPENDED itself on a blocking `escalate`, asking the user directly (the CEO is parked at its
 * `delegate` mid-wave, so it cannot mediate; 阻塞式求决策 §4.5). Rendered under the assistant
 * bubble that raised it, alongside any ask_user / plan_review cards.
 *
 * UNLIKE those gates the escalation does NOT pause the turn — siblings keep running and a timeout
 * degrades to the worker's stated assumption — so the card is derived from the execution store's
 * `runs[].escalations` (not a conversation-store gate) and the cards are plural per turn.
 *
 * Three states (设计 §4.5A): `interactive` (live + suspended → answerable), dormant (a reloaded /
 * turn-ended `pending` → a static record), resolved (answered → shows the answer; timeout → 已按假设
 * 继续). There is no 停止 — ending the whole turn is the CEO `ask_user` / conversation-level job.
 */
export function EscalationCard({
  escalation,
  role,
  conversationId,
  interactive,
}: {
  escalation: RunEscalation;
  role: string;
  conversationId: string | null;
  interactive: boolean;
}) {
  if (escalation.status === "resolved" || escalation.status === "timeout") {
    return <ResolvedEscalation escalation={escalation} role={role} />;
  }
  if (!interactive) {
    return <DormantEscalation escalation={escalation} role={role} />;
  }
  return (
    <PendingEscalation
      escalation={escalation}
      role={role}
      conversationId={conversationId}
    />
  );
}

/** The live, actionable card: the worker's question + its read-only fallback assumption, settled by
 * 提交 (the user's answer) or 按假设继续 (degrade to the assumption — equivalent to an early timeout). */
function PendingEscalation({
  escalation,
  role,
  conversationId,
}: {
  escalation: RunEscalation;
  role: string;
  conversationId: string | null;
}) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState<
    EscalationUserDecision["kind"] | null
  >(null);
  const busy = submitting !== null;

  const send = (decision: EscalationUserDecision) => {
    if (busy || !conversationId || !escalation.id) return;
    setSubmitting(decision.kind);
    // The suspending tool's awaiter emits escalation_resolved (单一发射者), which folds this card to
    // its settled state — so success needs no local mutation. A transient (non-404) failure re-lights
    // the card + toasts (404/stale is swallowed in the service). Mirrors PlanReviewCard.
    decideEscalation(conversationId, escalation.id, decision).catch((err) => {
      notifyError(err, "提交失败");
      setSubmitting(null);
    });
  };

  return (
    <div className="animate-task-card-enter rounded-xl border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <HelpCircle size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-warning">{role} · 请你拍板</p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
            {escalation.question}
          </p>
          <p className="mt-2 rounded-lg bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground">
            未答则按此继续：{escalation.assumption}
          </p>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="输入你的决定（留空则点「按假设继续」）"
            className="mt-2 w-full resize-none rounded-lg border border-border bg-card/70 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-warning/60 focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <button
          type="button"
          onClick={() => send({ kind: "answer", answer: answer.trim() })}
          disabled={busy || !answer.trim()}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {submitting === "answer" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          <span>提交</span>
        </button>
        <button
          type="button"
          onClick={() => send({ kind: "use_assumption" })}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          {submitting === "use_assumption" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <ArrowRight size={13} />
          )}
          <span>按假设继续</span>
        </button>
      </div>
    </div>
  );
}

/** A pending escalation on a turn that is no longer live (reloaded, or the turn ended without an
 * answer): a static record, not actionable. */
function DormantEscalation({
  escalation,
  role,
}: {
  escalation: RunEscalation;
  role: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-2">
        <HelpCircle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            {role} 曾请你拍板（本回合已结束）
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
            {escalation.question}
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            暂定假设：{escalation.assumption}
          </p>
        </div>
      </div>
    </div>
  );
}

/** The settled record: an answered escalation shows the user's answer; a timed-out one shows it
 * fell back to the worker's assumption (已按假设继续). */
function ResolvedEscalation({
  escalation,
  role,
}: {
  escalation: RunEscalation;
  role: string;
}) {
  const isTimeout = escalation.status === "timeout";
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {isTimeout ? <Clock size={14} /> : <Check size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            {role} · {isTimeout ? "已按假设继续" : "已答复"}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
            {escalation.question}
          </p>
          {isTimeout ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              按假设继续：{escalation.assumption}
            </p>
          ) : (
            escalation.answer && (
              <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
                {escalation.answer}
              </p>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Turn-level escalation cards for one assistant message (阻塞式求决策 §4.5B): derives the BLOCKING
 * escalations from the message's execution slot — non-blocking `raised` banners stay in the run
 * detail, so only `status !== "raised"` get a card. Subscribes to the execution slot here (not in
 * the bubble) so only this section re-renders as the team streams. `interactive` is the turn's
 * non-terminal state (the live, streaming bubble); a reloaded / ended turn renders dormant/settled.
 */
export function EscalationCards({
  messageId,
  conversationId,
  interactive,
}: {
  messageId: string;
  conversationId: string | null;
  interactive: boolean;
}) {
  const execution = useMessageExecution(messageId);
  if (!execution) return null;

  const roleById = new Map(execution.agents.map((a) => [a.id, a.role]));
  // A worker is sequential ⇒ at most one pending escalation per run (设计 §4.7); but a run can hold
  // a settled one too, so flatten all blocking escalations across runs in fire order.
  const items = execution.runs.flatMap((run) =>
    run.escalations
      .filter((e) => e.status !== "raised")
      .map((e, i) => ({
        esc: e,
        role: roleById.get(run.agentId) ?? run.agentId,
        key: e.id ?? `${run.id}-${i}`,
      })),
  );
  if (items.length === 0) return null;

  const pendingCount = items.filter((i) => i.esc.status === "pending").length;

  return (
    <div className="mt-2 space-y-2">
      {pendingCount > 0 && (
        <p className="text-xs font-medium text-warning">
          团队有 {pendingCount} 项待你拍板
        </p>
      )}
      {items.map((i) => (
        <EscalationCard
          key={i.key}
          escalation={i.esc}
          role={i.role}
          conversationId={conversationId}
          interactive={interactive}
        />
      ))}
    </div>
  );
}
