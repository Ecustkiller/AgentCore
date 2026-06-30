import { DecisionCard, DecisionCardIcon } from "@/components/ui";
import type { PlanReviewDisplay } from "@/stores/conversation";
import { Check, Clock, GitBranch, OctagonX, Pencil } from "lucide-react";

/**
 * Inline plan_review card — the WaveScheduler paused after a `checkpoint_after` step
 * completed and before its dependents run (结构化挂起). Rendered under the assistant
 * bubble that raised it (会话流内，alongside any ask_user checkpoints), replaying inline on
 * reload.
 *
 * 挂起即收口 (②, Phase 3): plan_review never parks live inline anymore — the scheduler
 * finalizes the turn at the boundary (`SUSPEND → PAUSED`), so the actionable surface is the
 * durable resume card (ResumePrompt). Inline, this renders only as a passive record: a
 * pending review on a finished/reloaded turn is a dormant record; a resolved one shows its
 * settled state (继续 ran the gated downstream / 调整 steered it / 停止 ended the run).
 */
export function PlanReviewCard({ review }: { review: PlanReviewDisplay }) {
  if (review.status === "resolved") {
    return <ResolvedPlanReview review={review} />;
  }
  return <DormantPlanReview review={review} />;
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
