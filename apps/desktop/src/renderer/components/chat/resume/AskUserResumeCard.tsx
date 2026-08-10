import { BrowserLoginDecisionCard } from "@/components/chat/BrowserLoginDecisionCard";
import { AskUserCard } from "@/components/chat/CheckpointCard";
import { DecisionCard, DecisionCardIcon } from "@/components/ui";
import { notifyError } from "@/lib/toast";
import {
  submitInteraction,
  submitInteractionFeedback,
} from "@/services/interactionSubmit";
import type { PlanReviewUserDecision } from "@/services/planReview";
import { useInteractionStore } from "@/stores/interactions";
import type { PendingResume } from "@/stores/pausedTurns";
import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { ResumeDeferredNotice } from "./ResumeDeferredNotice";

function formatBrowserLoginAssumption(
  assumptions: PendingResume["assumptions"],
): string | undefined {
  if (assumptions.length === 0) return undefined;
  const text = assumptions
    .map((a) => {
      const label = a.label?.trim() ?? "";
      const value = a.value?.trim() ?? "";
      if (label && value) return `${label}：${value}`;
      return value || label;
    })
    .filter(Boolean)
    .join("；");
  return text || undefined;
}

function AskUserBrowserLoginResumeCard({ turn }: { turn: PendingResume }) {
  const [submitting, setSubmitting] = useState<
    "logged_in" | "use_assumption" | "stop" | null
  >(null);
  const entryStatus = useInteractionStore(
    (s) => s.byId.get(turn.checkpointId)?.status,
  );
  const deferredBusyReason = useInteractionStore(
    (s) => s.byId.get(turn.checkpointId)?.resumeDeferred?.busyReason ?? null,
  );
  const busy =
    submitting !== null ||
    entryStatus === "submitting" ||
    deferredBusyReason !== null;
  const assumption = formatBrowserLoginAssumption(turn.assumptions);

  if (deferredBusyReason) {
    return (
      <DecisionCard tone="neutral" animate className="mx-0 p-3">
        <div className="flex items-start gap-2">
          <DecisionCardIcon tone="neutral">
            <MessageCircleQuestion size={16} />
          </DecisionCardIcon>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-semibold text-foreground">已记下</p>
            <ResumeDeferredNotice busyReason={deferredBusyReason} />
          </div>
        </div>
      </DecisionCard>
    );
  }

  const send = async (
    decision: "continue" | "stop",
    opts?: { useAssumption?: boolean },
  ) => {
    if (busy) return;
    const useAssumption = opts?.useAssumption === true && !!assumption;
    setSubmitting(
      useAssumption
        ? "use_assumption"
        : decision === "continue"
          ? "logged_in"
          : "stop",
    );
    try {
      const result = await submitInteraction({
        id: turn.checkpointId,
        kind: "ask_user",
        conversationId: turn.conversationId,
        cold: {
          messageId: turn.messageId,
          decision,
          note: useAssumption
            ? assumption
            : decision === "continue"
              ? "已登录，继续"
              : "",
          selected: [],
        },
      });
      if (result !== "ok") {
        notifyError(submitInteractionFeedback(result));
        setSubmitting(null);
      }
    } catch (err) {
      notifyError(err, "提交失败");
      setSubmitting(null);
    }
  };

  return (
    <BrowserLoginDecisionCard
      roleLabel="主 Agent"
      question={turn.question || "请在右坞浏览器完成登录"}
      assumption={assumption}
      conversationId={turn.conversationId}
      revealKey={turn.checkpointId}
      busy={busy}
      submitting={submitting}
      onLoggedIn={() => void send("continue")}
      onUseAssumption={
        assumption
          ? () => void send("continue", { useAssumption: true })
          : undefined
      }
      onStop={() => void send("stop")}
    />
  );
}

/** Cold-path ask_user resume card — reuses hot AskUserCard / browser-login shell. */
export function AskUserResumeCard({ turn }: { turn: PendingResume }) {
  const deferredBusyReason = useInteractionStore(
    (s) => s.byId.get(turn.checkpointId)?.resumeDeferred?.busyReason ?? null,
  );

  if (deferredBusyReason) {
    return (
      <DecisionCard tone="neutral" animate className="mx-0 p-3">
        <div className="flex items-start gap-2">
          <DecisionCardIcon tone="neutral">
            <MessageCircleQuestion size={16} />
          </DecisionCardIcon>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-semibold text-foreground">已记下</p>
            <ResumeDeferredNotice busyReason={deferredBusyReason} />
          </div>
        </div>
      </DecisionCard>
    );
  }

  if (turn.browserLogin) {
    return <AskUserBrowserLoginResumeCard turn={turn} />;
  }
  return (
    <AskUserCard
      content={turn}
      intent={turn.intent}
      disclosureKey={turn.checkpointId}
      conversationId={turn.conversationId}
      onSubmit={async (decision, note, selected = []) => {
        const result = await submitInteraction({
          id: turn.checkpointId,
          kind: "ask_user",
          conversationId: turn.conversationId,
          cold: {
            messageId: turn.messageId,
            decision: decision as PlanReviewUserDecision,
            note,
            selected,
          },
        });
        if (result !== "ok") {
          throw new Error(submitInteractionFeedback(result));
        }
      }}
    />
  );
}
