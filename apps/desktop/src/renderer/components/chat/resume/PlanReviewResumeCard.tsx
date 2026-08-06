import {
  Button,
  DecisionCard,
  DecisionCardIcon,
  Textarea,
} from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { PlanReviewUserDecision } from "@/services/planReview";
import type { PendingResume } from "@/stores/pausedTurns";
import { Check, GitBranch, Loader2, OctagonX, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { ConclusionHero } from "./ConclusionHero";
import { PlanReviewContextBand } from "./PlanReviewContextBand";
import { useColdSubmit } from "./useColdSubmit";

/** Cold-path plan_review resume card (拍板中心). */
export function PlanReviewResumeCard({ turn }: { turn: PendingResume }) {
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const { submitting, busy, send } = useColdSubmit(turn);

  const spinnerOr = (
    decision: PlanReviewUserDecision,
    icon: React.ReactNode,
  ) =>
    submitting === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  // 拍板中心（方案 C）：时间线只留单行标记，等谁 / 等什么 / 产出引用都在这张卡。
  const reviewedRoles = turn.steps.map((s) => s.role).filter(Boolean);
  const rolesLabel =
    reviewedRoles.length > 0 ? `「${reviewedRoles.join("、")}」` : "这一步";
  const disclosureKey = turn.checkpointId;
  const gateHint = turn.ceoReview?.source === "llm";

  const focusNote = () => {
    queueMicrotask(() => noteRef.current?.focus());
  };

  const continueBtn = (
    <Button
      variant="primary"
      icon={spinnerOr("continue", <Check size={13} />)}
      disabled={busy}
      onClick={() => send("continue", [], note.trim())}
      aria-label={gateHint ? "继续。继续后，把关要点将发给下游" : undefined}
    >
      继续
    </Button>
  );

  return (
    <DecisionCard
      tone="primary"
      animate
      className="mx-0 flex max-h-[min(60vh,36rem)] flex-col overflow-hidden p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-start gap-2">
            <DecisionCardIcon tone="primary">
              <GitBranch size={16} />
            </DecisionCardIcon>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-primary">
                计划复核 · 等你确认
              </p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">
                {rolesLabel}已完成
              </p>
              {turn.ceoReview?.conclusion && (
                <ConclusionHero text={turn.ceoReview.conclusion} />
              )}
              <PlanReviewContextBand
                turn={turn}
                disclosureKey={disclosureKey}
              />
            </div>
          </div>
        </div>

        <div className="shrink-0 space-y-2 border-t border-border bg-card/95 px-3 py-3 backdrop-blur-sm">
          <Textarea
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="可选备注；调整时必填"
            className="w-full border-border bg-card/70 focus:border-primary/60"
            data-testid="plan-review-note"
          />
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <Button
              variant="neutral"
              icon={spinnerOr("adjust", <Pencil size={13} />)}
              disabled={busy}
              onClick={() => {
                if (!note.trim()) {
                  focusNote();
                  return;
                }
                send("adjust", [], note.trim());
              }}
            >
              调整
            </Button>
            <Button
              variant="danger"
              icon={spinnerOr("stop", <OctagonX size={13} />)}
              disabled={busy}
              onClick={() => send("stop", [], note.trim())}
            >
              取消
            </Button>
            <span className="ml-auto" />
            {gateHint ? (
              <SimpleTooltip label="继续后，把关要点将发给下游">
                <span
                  className="inline-flex"
                  data-testid="plan-review-gate-notes-hint"
                >
                  {continueBtn}
                </span>
              </SimpleTooltip>
            ) : (
              continueBtn
            )}
          </div>
        </div>
      </div>
    </DecisionCard>
  );
}
