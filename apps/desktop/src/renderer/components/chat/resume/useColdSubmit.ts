import type { ResumeDeferredBusyReason } from "@/lib/resumeDeferred";
import { notifyError } from "@/lib/toast";
import {
  type TeamPreviewResumeCorrections,
  notifySubmitInteractionResult,
  submitInteraction,
} from "@/services/interactionSubmit";
import type { PlanReviewUserDecision } from "@/services/planReview";
import { useInteractionStore } from "@/stores/interactions";
import type { PendingResume } from "@/stores/pausedTurns";
import { useState } from "react";

/** Shared cold-path submit hook for plan_review / team_preview resume cards. */
export function useColdSubmit(
  turn: PendingResume,
  onSubmitted?: (decision: PlanReviewUserDecision) => void,
) {
  const [submitting, setSubmitting] = useState<PlanReviewUserDecision | null>(
    null,
  );
  const entryStatus = useInteractionStore(
    (s) => s.byId.get(turn.checkpointId)?.status,
  );
  const deferredBusyReason: ResumeDeferredBusyReason | null =
    useInteractionStore(
      (s) => s.byId.get(turn.checkpointId)?.resumeDeferred?.busyReason ?? null,
    );
  // Deferred keeps busy even if local state remounts — settlement already locked.
  const busy =
    submitting !== null ||
    entryStatus === "submitting" ||
    deferredBusyReason !== null;

  const send = (
    decision: PlanReviewUserDecision,
    selected: string[] = [],
    note = "",
    corrections?: TeamPreviewResumeCorrections,
  ) => {
    if (busy) return;
    setSubmitting(decision);
    const continueCorrections =
      decision === "continue" && corrections
        ? {
            ...(corrections.excluded_run_ids &&
            corrections.excluded_run_ids.length > 0
              ? { excluded_run_ids: corrections.excluded_run_ids }
              : {}),
            ...(corrections.write_capability_overrides &&
            corrections.write_capability_overrides.length > 0
              ? {
                  write_capability_overrides:
                    corrections.write_capability_overrides,
                }
              : {}),
            ...(corrections.model_overrides &&
            Object.keys(corrections.model_overrides).length > 0
              ? { model_overrides: corrections.model_overrides }
              : {}),
          }
        : {};
    void submitInteraction({
      id: turn.checkpointId,
      kind: turn.kind,
      conversationId: turn.conversationId,
      cold: {
        messageId: turn.messageId,
        decision,
        note,
        selected,
        ...continueCorrections,
      },
    })
      .then((result) => {
        if (result !== "ok") {
          notifySubmitInteractionResult(result);
          setSubmitting(null);
          return;
        }
        onSubmitted?.(decision);
        setSubmitting(null);
      })
      .catch((err) => {
        notifyError(err, "提交失败");
        setSubmitting(null);
      });
  };

  return {
    submitting,
    busy,
    deferredBusyReason,
    send,
  };
}
