import { AskUserCard } from "@/components/chat/CheckpointCard";
import { DecisionCard, DecisionCardIcon } from "@/components/ui";
import {
  submitInteraction,
  submitInteractionFeedback,
} from "@/services/interactionSubmit";
import { useInteractionStore } from "@/stores/interactions";
import type { PendingResume } from "@/stores/pausedTurns";
import { MessageCircleQuestion } from "lucide-react";
import { ResumeDeferredNotice } from "./ResumeDeferredNotice";

/** Cold-path ask_user resume card — reuses hot AskUserCard. */
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
            decision,
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
