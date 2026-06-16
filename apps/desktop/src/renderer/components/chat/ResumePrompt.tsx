import type { PlanReviewUserDecision } from "@/services/planReview";
import { runResume } from "@/services/turns";
import { useConversationStore } from "@/stores/conversation";
import { type PendingResume, usePausedTurnStore } from "@/stores/pausedTurns";
import {
  ArrowRight,
  Check,
  CircleHelp,
  GitBranch,
  Loader2,
  OctagonX,
  Pencil,
} from "lucide-react";
import { useState } from "react";

/**
 * Resume prompt for durably-paused turns (结构化挂起 2b).
 *
 * A turn that paused at a plan_review / ask_user checkpoint then lost its live
 * stream (disconnect / restart) has no assistant reply yet — only a persisted
 * frame. On reopen we list those frames (GET /paused → store) and render a card per
 * turn above the composer, where it is always visible. Each offers 继续/提交 / 停止
 * (plan_review also 调整) → POST .../resume, which continues the turn on a fresh
 * stream. The card variant follows the frame's `kind`. Renders nothing when the
 * active conversation has no paused turns.
 */
export function ResumePrompt() {
  // Only the conversation on screen owns the composer, so only its paused turns
  // belong above it — other conversations' wait until you switch back.
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const pending = usePausedTurnStore((s) => s.pending);
  const visible = pending.filter((p) => p.conversationId === conversationId);
  if (visible.length === 0) return null;

  return (
    <div className="mx-4 mb-2 space-y-2">
      {visible.map((turn) => (
        <ResumeCard key={turn.messageId} turn={turn} />
      ))}
    </div>
  );
}

/** Dispatch to the card matching the frame's suspend point. */
function ResumeCard({ turn }: { turn: PendingResume }) {
  return turn.kind === "ask_user" ? (
    <AskUserResumeCard turn={turn} />
  ) : (
    <PlanReviewResumeCard turn={turn} />
  );
}

/** The just-completed step(s) under review: each worker's role + a capped excerpt
 * of its product (the backend already truncates `summary`). */
function ReviewedSteps({ turn }: { turn: PendingResume }) {
  return (
    <div className="mt-2 space-y-1.5">
      {turn.steps.map((s) => (
        <div
          key={s.run_id}
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
        >
          <p className="text-xs font-medium text-foreground">{s.role}</p>
          {s.summary && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
              {s.summary}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** A compact preview of the downstream nodes gated behind this pause. */
function PendingPreview({ turn }: { turn: PendingResume }) {
  if (turn.pending.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ArrowRight size={13} className="shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">继续后将运行</span>
      {turn.pending.map((n) => (
        <span
          key={n.run_id}
          className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-foreground"
        >
          {n.role}
        </span>
      ))}
    </div>
  );
}

/** plan_review resume: review the finished checkpoint step(s) + gated downstream,
 * then 继续 (run as-is) / 调整 (steer + continue) / 停止. */
function PlanReviewResumeCard({ turn }: { turn: PendingResume }) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<PlanReviewUserDecision | null>(
    null,
  );
  const busy = submitting !== null;

  const send = (decision: PlanReviewUserDecision) => {
    if (busy) return;
    setSubmitting(decision);
    // runResume drops this card and opens the assistant bubble for the
    // continuation; a refused POST (e.g. quota) raises a retry banner instead.
    // The card is gone the moment resume starts, so there is nothing to re-enable.
    void runResume(turn.messageId, decision, note.trim());
  };

  return (
    <div className="animate-task-card-enter rounded-xl border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <GitBranch size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-warning">
            上次执行已暂停（连接已断开）· 待你决定是否继续
          </p>
          <p className="mt-0.5 text-sm text-foreground">这一步已完成，请过目：</p>
          <ReviewedSteps turn={turn} />
          <PendingPreview turn={turn} />

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="可选 · 备注（调整时作为对下游的指示；停止时作为收尾备注）"
            className="mt-2 w-full resize-none rounded-lg border border-border bg-card/70 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-warning/60 focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <DecisionButton
          icon={spinnerOr(submitting, "continue", <Check size={13} />)}
          label="继续"
          tone="primary"
          disabled={busy}
          onClick={() => send("continue")}
        />
        <DecisionButton
          icon={spinnerOr(submitting, "adjust", <Pencil size={13} />)}
          label="调整"
          tone="neutral"
          disabled={busy || !note.trim()}
          onClick={() => send("adjust")}
        />
        <DecisionButton
          icon={spinnerOr(submitting, "stop", <OctagonX size={13} />)}
          label="停止"
          tone="danger"
          disabled={busy}
          onClick={() => send("stop")}
        />
      </div>
    </div>
  );
}

/** ask_user resume: re-ask the CEO's question + options, then 提交 (the picks /
 * note continue the CEO loop) / 停止 (the note closes the turn). Mirrors the live
 * checkpoint card so a reconnected pause reads identically to one answered live. */
function AskUserResumeCard({ turn }: { turn: PendingResume }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<PlanReviewUserDecision | null>(
    null,
  );
  const busy = submitting !== null;

  // Single-select replaces the pick (radio); multi-select toggles membership
  // (checkbox). Clicking an active option clears it either way.
  const toggle = (opt: string) => {
    if (busy) return;
    setSelected((cur) => {
      if (cur.includes(opt)) return cur.filter((o) => o !== opt);
      return turn.multiple ? [...cur, opt] : [opt];
    });
  };

  const send = (decision: PlanReviewUserDecision) => {
    if (busy) return;
    // Picks ride 提交 (continue); 停止 ends the turn and carries none.
    const picks = decision === "stop" ? [] : selected;
    setSubmitting(decision);
    void runResume(turn.messageId, decision, note.trim(), picks);
  };

  return (
    <div className="animate-task-card-enter rounded-xl border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <CircleHelp size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-warning">
            上次执行已暂停（连接已断开）· CEO 在等你拍板
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
            {turn.question}
          </p>
          {turn.context && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {turn.context}
            </p>
          )}

          {turn.options.length > 0 && (
            <div className="mt-2 space-y-1">
              {turn.multiple && (
                <p className="text-xs text-muted-foreground/80">可多选</p>
              )}
              {turn.options.map((opt) => {
                const active = selected.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={busy}
                    onClick={() => toggle(opt)}
                    className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
                      active
                        ? "border-warning bg-warning/15 text-foreground"
                        : "border-border bg-card/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex size-3 shrink-0 items-center justify-center border ${
                        turn.multiple ? "rounded-lg" : "rounded-full"
                      } ${
                        active
                          ? "border-warning bg-warning text-warning-foreground"
                          : "border-border"
                      }`}
                    >
                      {turn.multiple && active && (
                        <Check size={10} strokeWidth={3} />
                      )}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap">{opt}</span>
                  </button>
                );
              })}
            </div>
          )}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="可选 · 补充说明或调整方向"
            className="mt-2 w-full resize-none rounded-lg border border-border bg-card/70 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-warning/60 focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <DecisionButton
          icon={spinnerOr(submitting, "continue", <Check size={13} />)}
          label="提交"
          tone="primary"
          disabled={busy}
          onClick={() => send("continue")}
        />
        <DecisionButton
          icon={spinnerOr(submitting, "stop", <OctagonX size={13} />)}
          label="停止"
          tone="danger"
          disabled={busy}
          onClick={() => send("stop")}
        />
      </div>
    </div>
  );
}

/** Swap a decision's icon for a spinner while that decision is in flight. */
function spinnerOr(
  submitting: PlanReviewUserDecision | null,
  decision: PlanReviewUserDecision,
  icon: React.ReactNode,
): React.ReactNode {
  return submitting === decision ? (
    <Loader2 size={13} className="animate-spin" />
  ) : (
    icon
  );
}

function DecisionButton({
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "primary" | "neutral" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneClass = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    neutral: "text-muted-foreground hover:bg-accent hover:text-foreground",
    danger: "text-destructive hover:bg-destructive/10",
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium disabled:opacity-40 ${toneClass}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
