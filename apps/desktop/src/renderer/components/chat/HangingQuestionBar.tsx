import { Button, DecisionCard, DecisionCardIcon } from "@/components/ui";
import {
  HANGING_QUESTION_CAPTION,
  HANGING_QUESTION_CTA,
  HANGING_QUESTION_DETACHED_HINT,
  formatHangingDefault,
} from "@/lib/hangingQuestion";
import { notifyError } from "@/lib/toast";
import { sendAskReply } from "@/services/askReply";
import { useConversationStore } from "@/stores/conversation";
import type { NonBlockingAskDisplay } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { usePendingHangingQuestions } from "@/stores/interactions";
import { Loader2, MessageCircle } from "lucide-react";
import { useState } from "react";

/**
 * Bottom-bar face for pending non-blocking questions.
 * Distinct from ResumePrompt (「需要你拍板」/ 团队停工). Do not reuse that shell.
 */
export function HangingQuestionBar() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const asks = usePendingHangingQuestions(conversationId);
  const detached = useExecutionStore((s) => {
    if (!conversationId) return false;
    const msgs =
      useConversationStore.getState().byId[conversationId]?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const slot =
        s.byId[m.id] ??
        (m.serverMessageId ? s.byId[m.serverMessageId] : undefined);
      return slot?.executionDetached != null;
    }
    return false;
  });
  if (!conversationId || asks.length === 0) return null;

  return (
    <div className="mx-4 mb-2 space-y-2" data-testid="hanging-question-bar">
      {asks.map((ask) => (
        <HangingQuestionCard
          key={ask.id}
          ask={ask}
          conversationId={conversationId}
          detached={detached}
        />
      ))}
    </div>
  );
}

function HangingQuestionCard({
  ask,
  conversationId,
  detached,
}: {
  ask: NonBlockingAskDisplay;
  conversationId: string;
  detached: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const defaultHint = formatHangingDefault(ask.assumptions);
  const canSend = draft.trim().length > 0 && !busy;

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const result = await sendAskReply({
        conversationId,
        askId: ask.id,
        text,
      });
      if (result === "ok" || result === "queued") {
        setDraft("");
        return;
      }
      notifyError("发送失败");
    } catch (err) {
      notifyError(err, "答复失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DecisionCard
      tone="neutral"
      className="mx-0 p-3"
      data-testid="hanging-question-card"
      data-ask-id={ask.id}
      data-hanging-urgency="running"
    >
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="neutral">
          <MessageCircle size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p
            className="text-xs font-medium text-muted-foreground"
            data-testid="hanging-question-caption"
          >
            {HANGING_QUESTION_CAPTION}
          </p>
          <p className="whitespace-pre-wrap text-sm font-semibold text-foreground">
            {ask.question}
          </p>
          {ask.context ? (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {ask.context}
            </p>
          ) : null}
          {defaultHint ? (
            <p className="text-xs text-muted-foreground">{defaultHint}</p>
          ) : null}
          {detached ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="hanging-question-detached-hint"
            >
              {HANGING_QUESTION_DETACHED_HINT}
            </p>
          ) : null}
          <textarea
            className="min-h-[4.5rem] w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground/25 focus:outline-none"
            placeholder="写给团队的答复"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="hanging-question-input"
          />
          <div className="flex justify-end">
            <Button
              variant="ghost"
              className="border border-border"
              disabled={!canSend}
              onClick={() => void submit()}
              data-testid="hanging-question-submit"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                HANGING_QUESTION_CTA
              )}
            </Button>
          </div>
        </div>
      </div>
    </DecisionCard>
  );
}
