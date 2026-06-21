import {
  Badge,
  Button,
  DecisionCard,
  DecisionCardIcon,
  Textarea,
} from "@/components/ui";
import { notifyError } from "@/lib/toast";
import {
  type PlanReviewUserDecision,
  decidePlanReview,
} from "@/services/planReview";
import type { PlanReviewDisplay } from "@/stores/conversation";
import {
  ArrowRight,
  Check,
  Clock,
  GitBranch,
  Loader2,
  OctagonX,
  Pencil,
} from "lucide-react";
import { useState } from "react";

/**
 * Inline plan_review card — the WaveScheduler paused after a `checkpoint_after`
 * step completed and before its dependents run (结构化挂起). Rendered under the
 * assistant bubble that raised it (会话流内，alongside any ask_user checkpoints), so
 * it both gates the live turn and replays inline on reload.
 *
 * `interactive` is true only for the live, suspended turn (the owning message is
 * still streaming). A pending review on a finished/reloaded turn renders as a
 * passive record; a resolved one always renders its settled state. Choices: 继续
 * (run the gated downstream as-is) / 调整 (inject the note as a steer onto the
 * downstream, then run) / 停止 (end the run here).
 */
export function PlanReviewCard({
  review,
  conversationId,
  interactive,
}: {
  review: PlanReviewDisplay;
  conversationId: string | null;
  interactive: boolean;
}) {
  if (review.status === "resolved") {
    return <ResolvedPlanReview review={review} />;
  }
  if (!interactive) {
    return <DormantPlanReview review={review} />;
  }
  return <PendingPlanReview review={review} conversationId={conversationId} />;
}

/** The just-completed step(s) under review: each worker's role + a capped excerpt
 * of its product (the backend already truncates `summary`). */
function ReviewedSteps({ review }: { review: PlanReviewDisplay }) {
  return (
    <div className="mt-2 space-y-1.5">
      {review.steps.map((s) => (
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
function PendingPreview({ review }: { review: PlanReviewDisplay }) {
  if (review.pending.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ArrowRight size={13} className="shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">继续后将运行</span>
      {review.pending.map((n) => (
        <Badge key={n.run_id} tone="muted">
          {n.role}
        </Badge>
      ))}
    </div>
  );
}

/** The live, actionable card: reviewed step(s) + gated downstream + an optional
 * note, settled by 继续 / 调整 / 停止. */
function PendingPlanReview({
  review,
  conversationId,
}: {
  review: PlanReviewDisplay;
  conversationId: string | null;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<PlanReviewUserDecision | null>(
    null,
  );
  const busy = submitting !== null;

  const send = (decision: PlanReviewUserDecision) => {
    if (busy || !conversationId) return;
    setSubmitting(decision);
    decidePlanReview(conversationId, review.id, decision, note.trim()).catch(
      (err) => {
        notifyError(err, "提交失败");
        setSubmitting(null);
      },
    );
  };

  const spinnerOr = (
    decision: PlanReviewUserDecision,
    icon: React.ReactNode,
  ) =>
    submitting === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  return (
    <DecisionCard tone="warning" animate>
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="warning">
          <GitBranch size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-warning">
            执行已暂停 · 待你放行下一步
          </p>
          <p className="mt-0.5 text-sm text-foreground">
            这一步已完成，请过目：
          </p>
          <ReviewedSteps review={review} />
          <PendingPreview review={review} />

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="可选 · 备注（调整时作为对下游的指示；停止时作为收尾备注）"
            className="mt-2 w-full border-border bg-card/70 focus:border-warning/60"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <Button
          variant="primary"
          icon={spinnerOr("continue", <Check size={13} />)}
          disabled={busy}
          onClick={() => send("continue")}
        >
          继续
        </Button>
        <Button
          variant="neutral"
          icon={spinnerOr("adjust", <Pencil size={13} />)}
          disabled={busy || !note.trim()}
          onClick={() => send("adjust")}
        >
          调整
        </Button>
        <Button
          variant="danger"
          icon={spinnerOr("stop", <OctagonX size={13} />)}
          disabled={busy}
          onClick={() => send("stop")}
        >
          停止
        </Button>
      </div>
    </DecisionCard>
  );
}

/** A pending review on a turn that is no longer live (reloaded, or the turn ended
 * without an answer): shown as a record, not actionable. */
function DormantPlanReview({ review }: { review: PlanReviewDisplay }) {
  return (
    <DecisionCard tone="neutral">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="neutral">
          <GitBranch size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            曾在此暂停过目（本回合已结束）
          </p>
          <ReviewedSteps review={review} />
        </div>
      </div>
    </DecisionCard>
  );
}

/** The settled record of a plan_review: whether the downstream was released. */
function ResolvedPlanReview({ review }: { review: PlanReviewDisplay }) {
  const meta = {
    continue: { icon: <Check size={14} />, label: "已继续 · 放行下游" },
    adjust: {
      icon: <Pencil size={14} />,
      label: "已调整 · 指示已注入下游并继续",
    },
    stop: { icon: <OctagonX size={14} />, label: "已停止 · 未运行下游" },
    timeout: { icon: <Clock size={14} />, label: "未及时回应，已自动放行继续" },
  }[review.decision ?? "timeout"];

  return (
    <DecisionCard tone="neutral" className="bg-card/60">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <ReviewedSteps review={review} />
          <p className="mt-1.5 text-xs font-medium text-muted-foreground">
            {meta.label}
          </p>
          {review.note && (
            <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
              {review.note}
            </p>
          )}
        </div>
      </div>
    </DecisionCard>
  );
}
