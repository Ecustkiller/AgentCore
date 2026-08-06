import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { usePersistentDisclosure } from "@/stores/disclosure";
import type { PendingResume } from "@/stores/pausedTurns";
import { AlertTriangle, ArrowRight, ChevronRight } from "lucide-react";
import { CeoReviewList } from "./CeoReviewList";

/**
 * 上下文带（B1）：风险/建议与产出→下游同一行次要 meta，默认全收，点开再展开详情。
 * 结论仍在决策头；testid 保持兼容。
 */
export function PlanReviewContextBand({
  turn,
  disclosureKey,
}: {
  turn: PendingResume;
  disclosureKey: string;
}) {
  const [ceoOpen, setCeoOpen] = usePersistentDisclosure(
    `${disclosureKey}:ceo-review`,
    false,
  );
  const [stepsOpen, setStepsOpen] = usePersistentDisclosure(
    `${disclosureKey}:steps`,
    false,
  );

  const review = turn.ceoReview;
  const riskCount = review?.risks.length ?? 0;
  const suggestionCount = review?.suggestions.length ?? 0;
  const hasCeo = riskCount > 0 || suggestionCount > 0;
  const hasSteps = turn.steps.length > 0;
  const hasPending = turn.pending.length > 0;
  if (!hasCeo && !hasSteps && !hasPending) return null;

  const ceoSummary = [
    riskCount > 0 ? `${riskCount} 风险` : null,
    suggestionCount > 0 ? `${suggestionCount} 建议` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const roles = turn.steps.map((s) => s.role).filter(Boolean);
  const stepsPreview =
    roles.length > 0 ? roles.join(" · ") : `${turn.steps.length} 步`;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {hasCeo && review && (
          <span data-testid="ceo-review-summary">
            <button
              type="button"
              onClick={() => setCeoOpen((v) => !v)}
              aria-expanded={ceoOpen}
              data-testid="ceo-review-more-toggle"
              className="inline-flex max-w-full cursor-pointer items-center gap-1 text-left hover:text-foreground"
            >
              <AlertTriangle
                size={13}
                className="shrink-0 text-foreground/70"
                aria-hidden
              />
              <span className="min-w-0 truncate font-medium text-foreground/80">
                {ceoSummary}
              </span>
              <ChevronRight
                size={13}
                className={cn(
                  "shrink-0 transition-transform",
                  ceoOpen && "rotate-90",
                )}
              />
            </button>
          </span>
        )}
        {hasSteps && (
          <button
            type="button"
            onClick={() => setStepsOpen((v) => !v)}
            aria-expanded={stepsOpen}
            data-testid="plan-review-steps-toggle"
            className="inline-flex max-w-full cursor-pointer items-center gap-1 text-left hover:text-foreground"
          >
            <ChevronRight
              size={13}
              className={cn(
                "shrink-0 transition-transform",
                stepsOpen && "rotate-90",
              )}
            />
            <span className="shrink-0 font-medium text-foreground/80">
              产出
            </span>
            {!stepsOpen && (
              <span className="min-w-0 truncate">· {stepsPreview}</span>
            )}
          </button>
        )}
        {hasPending && (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <ArrowRight size={13} className="shrink-0" />
            <span>下游</span>
            {turn.pending.map((n) => (
              <Badge key={n.run_id} tone="muted">
                {n.role}
              </Badge>
            ))}
          </span>
        )}
      </div>
      {ceoOpen && hasCeo && review && (
        <div className="mt-1.5 space-y-1 border-l-2 border-border/70 pl-2.5">
          <CeoReviewList label="风险" items={review.risks} />
          <CeoReviewList label="建议" items={review.suggestions} />
          <button
            type="button"
            onClick={() => setCeoOpen(false)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            收起详情
          </button>
        </div>
      )}
      {stepsOpen && hasSteps && (
        <div className="mt-1.5 space-y-1.5 border-l-2 border-border/70 pl-2.5">
          {turn.steps.map((s) => (
            <div key={s.run_id}>
              <p className="text-xs font-medium text-foreground">{s.role}</p>
              {s.summary && (
                <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                  {s.summary}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
