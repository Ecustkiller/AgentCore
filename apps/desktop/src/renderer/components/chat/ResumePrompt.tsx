import {
  Badge,
  Button,
  DecisionCard,
  DecisionCardIcon,
  Textarea,
} from "@/components/ui";
import type { PlanReviewUserDecision } from "@/services/planReview";
import { runResume } from "@/services/turns";
import { useConversationStore } from "@/stores/conversation";
import { type PendingResume, usePausedTurnStore } from "@/stores/pausedTurns";
import {
  ArrowRight,
  Check,
  GitBranch,
  Loader2,
  OctagonX,
  Pencil,
} from "lucide-react";
import { useState } from "react";
import { AskUserCard } from "./CheckpointCard";

export function ResumePrompt() {
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

function ResumeCard({ turn }: { turn: PendingResume }) {
  return turn.kind === "ask_user" ? (
    <AskUserResumeCard turn={turn} />
  ) : (
    <PlanReviewResumeCard turn={turn} />
  );
}

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

function PendingPreview({ turn }: { turn: PendingResume }) {
  if (turn.pending.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ArrowRight size={13} className="shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">继续后将运行</span>
      {turn.pending.map((n) => (
        <Badge key={n.run_id} tone="muted">
          {n.role}
        </Badge>
      ))}
    </div>
  );
}

function PlanReviewResumeCard({ turn }: { turn: PendingResume }) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<PlanReviewUserDecision | null>(
    null,
  );
  const busy = submitting !== null;

  const send = (decision: PlanReviewUserDecision) => {
    if (busy) return;
    setSubmitting(decision);
    void runResume(turn.messageId, decision, note.trim());
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
    <DecisionCard tone="primary" animate className="mx-0">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="primary">
          <GitBranch size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-primary">
            已暂停 · 待你决定是否继续
          </p>
          <p className="mt-0.5 text-sm text-foreground">
            这一步已完成，请过目：
          </p>
          <ReviewedSteps turn={turn} />
          <PendingPreview turn={turn} />

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="可选 · 备注（调整时作为对下游的指示；停止时作为收尾备注）"
            className="mt-2 w-full border-border bg-card/70 focus:border-primary/60"
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

function AskUserResumeCard({ turn }: { turn: PendingResume }) {
  return (
    <AskUserCard
      content={turn}
      intent={turn.intent}
      onSubmit={(decision, note) =>
        runResume(turn.messageId, decision, note, [])
      }
    />
  );
}
