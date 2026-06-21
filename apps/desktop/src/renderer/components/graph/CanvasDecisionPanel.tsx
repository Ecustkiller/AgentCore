import { ApprovalPrompt } from "@/components/chat/ApprovalPrompt";
import { CheckpointCard } from "@/components/chat/CheckpointCard";
import { EscalationCards } from "@/components/chat/EscalationCard";
import { RecoveryActions } from "@/components/chat/InlineTeamGraph";
import { PlanReviewCard } from "@/components/chat/PlanReviewCard";
import { ResumePrompt } from "@/components/chat/ResumePrompt";
import { RetryBanner } from "@/components/chat/RetryBanner";
import type { Message } from "@/stores/conversation";
import { type Execution, ExecutionScopeContext } from "@/stores/execution";
import { AlertTriangle, Gavel, X } from "lucide-react";

/**
 * 作战室「图上指挥」指挥台 (前端UX设计.md §6.2). The boss powers散落在聊天流里
 * (前端UX设计.md §三): ask_user / plan_review / 工作者上报 (turn level) + 工具放行
 * approval / 待恢复续跑 resume + 救火 (conversation / turn level). On the canvas they
 * belong where they happen, but the actionable cards are sizable, so this docks them
 * on the right — the war room's 指挥台 — rather than floating popovers over nodes. It
 * renders the SAME cards the chat surfaces do ({@link CheckpointCard} /
 * {@link PlanReviewCard} / {@link EscalationCards} / {@link ApprovalPrompt} /
 * {@link ResumePrompt} / {@link RetryBanner} / {@link RecoveryActions}), reused
 * verbatim, so a decision read / made / 救火 here is identical to one in chat and
 * folds through the very same service + SSE (no second data path — 设计 §二 单一数据源).
 *
 * Why every scope lives here: in canvas mode `ChatView` + `InlineTeamGraph` are
 * unmounted, so their conversation-level approval / resume / transport-retry prompts
 * and the team strip's 救火行 would be invisible (unactionable) without this. The
 * turn-level cards + recovery scope to the focused turn (`message` + projected
 * `execution`); approval / resume / RetryBanner are self-contained (own store +
 * active conversation) so they ride along regardless of `message`. `interactive` is
 * the focused turn's live, non-terminal state; a reloaded / ended turn renders its
 * cards as passive records. The host {@link import("./ConversationCanvas")} shows
 * this only while something is pending or recoverable (auto-surfaced — the boss must
 * decide / 救火).
 */

/** Count of UNANSWERED boss decisions on ONE turn (ask_user + plan_review + 工作者上报).
 * Turn-scoped: drives the focused node's「待你拍板」chip, and is the turn-level summand of
 * the host's panel auto-surface (which also adds conversation-level approval / resume). */
export function countPendingDecisions(
  message: Message | undefined,
  execution: Execution | null | undefined,
): number {
  let n = 0;
  for (const c of message?.checkpoints ?? []) if (c.status === "pending") n++;
  for (const p of message?.planReviews ?? []) if (p.status === "pending") n++;
  for (const r of execution?.runs ?? [])
    for (const e of r.escalations) if (e.status === "pending") n++;
  return n;
}

/** Whether the focused turn has terminal trouble the boss can 救火 — mirror of the
 * chat 救火行 gate (`InlineTeamGraph`): a turn-level crash (`failed`), a stopped turn
 * (`cancelled`), or a partial failure (`completed` with ≥1 failed run). A running /
 * planning / paused turn is in-flight, not yet recoverable. */
export function isTurnRecoverable(
  execution: Execution | null | undefined,
): boolean {
  if (!execution) return false;
  if (execution.status === "failed" || execution.status === "cancelled")
    return true;
  return (
    execution.status === "completed" &&
    execution.runs.some((r) => r.status === "failed")
  );
}

export function CanvasDecisionPanel({
  message,
  execution,
  conversationId,
  interactive,
  pending,
  onClose,
}: {
  /** The focused turn, for its turn-level cards (ask_user / plan_review / 上报) and
   * 救火行 scope. May be absent (e.g. a single-agent conversation whose only pending
   * item is an approval or a transport error) — conversation-level prompts still
   * render. */
  message?: Message;
  /** The focused turn's projected execution — gates / describes the 救火行. */
  execution?: Execution | null;
  conversationId: string | null;
  interactive: boolean;
  /** Live pending DECISION count, for the header badge (the host already computed it). */
  pending: number;
  onClose: () => void;
}) {
  const checkpoints = message?.checkpoints ?? [];
  const planReviews = message?.planReviews ?? [];

  const recoverable = isTurnRecoverable(execution);
  const failedCount =
    execution?.runs.filter((r) => r.status === "failed").length ?? 0;
  const recoveryNotice =
    execution?.status === "cancelled"
      ? "本回合已停止。可重试，或调整指令后重发。"
      : failedCount > 0
        ? `${failedCount} 个子任务失败。可重试，或调整指令后重发。`
        : "本回合执行失败。可重试，或调整指令后重发。";

  return (
    <aside className="relative flex w-[360px] shrink-0 flex-col border-l border-border bg-card">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
        <Gavel size={15} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          指挥台
          {pending > 0 && (
            <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
              {pending}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起指挥台"
          title="收起指挥台"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {/* 救火 (firefighting): a conversation-level transport error (send / resume /
            regenerate drop) + the focused turn's whole-turn recovery row (重试 / 调整 /
            忽略). RetryBanner is self-contained; RecoveryActions retries from the last
            user message but its 忽略 clears THIS turn's slot, so it runs under the
            focused turn's ExecutionScope. */}
        <RetryBanner />
        {recoverable && message && (
          <ExecutionScopeContext.Provider value={message.id}>
            <div className="mx-4 mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>{recoveryNotice}</span>
              </div>
              <RecoveryActions abandonLabel="忽略" />
            </div>
          </ExecutionScopeContext.Provider>
        )}
        {/* Conversation-level decisions (self-contained: own store + active
            conversation). They bring their own mx-4 mb-2 gutter, so the turn-level
            cards below match with px-4 and the mb-2 supplies the inter-group gap. */}
        <ApprovalPrompt />
        <ResumePrompt />
        {/* Turn-level: scoped to the focused turn's message + execution. */}
        <div className="space-y-2 px-4">
          {checkpoints.map((cp) => (
            <CheckpointCard
              key={cp.id}
              checkpoint={cp}
              conversationId={conversationId}
              interactive={interactive}
            />
          ))}
          {planReviews.map((pr) => (
            <PlanReviewCard
              key={pr.id}
              review={pr}
              conversationId={conversationId}
              interactive={interactive}
            />
          ))}
          {message && (
            <EscalationCards
              messageId={message.id}
              conversationId={conversationId}
              interactive={interactive}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
