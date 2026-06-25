import { ApprovalPrompt } from "@/components/chat/ApprovalPrompt";
import { BackgroundTaskCard } from "@/components/chat/BackgroundTaskCard";
import { CheckpointCard } from "@/components/chat/CheckpointCard";
import { DebateRoundDecisionCards } from "@/components/chat/DebateRoundDecisionCard";
import { EscalationCards } from "@/components/chat/EscalationCard";
import { PlanReviewCard } from "@/components/chat/PlanReviewCard";
import { ResumePrompt } from "@/components/chat/ResumePrompt";
import { RetryBanner } from "@/components/chat/RetryBanner";
import { RecoveryActions } from "@/components/chat/StatusStrip";
import { IconButton } from "@/components/ui";
import { useApprovalStore } from "@/stores/approvals";
import {
  useBackgroundTasks,
  useWorkspaceRootId,
} from "@/stores/backgroundTasks";
import { useCommandPanelStore } from "@/stores/commandPanel";
import {
  type Message,
  useActiveError,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import {
  type Execution,
  ExecutionScopeContext,
  useMessageExecution,
} from "@/stores/execution";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import { useSidePanelStore } from "@/stores/sidePanel";
import { AlertTriangle, ChevronDown, ChevronUp, Gavel } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

/**
 * 画布「图上指挥」指挥台 (前端UX设计.md §6.2). The boss powers散落在聊天流里
 * (前端UX设计.md §三): ask_user / plan_review / 工作者上报 (turn level) + 工具放行
 * approval / 待恢复续跑 resume + 救火 (conversation / turn level). On the canvas they
 * belong where they happen, but the actionable cards are sizable, so rather than
 * floating popovers over nodes — and rather than a SECOND right-hand dock競 the
 * unified side panel for width — the 指挥台 is now a collapsible region pinned to the
 * TOP of that one side panel ({@link CommandRegion}, §十). It renders the SAME cards
 * the chat surfaces do ({@link CheckpointCard} / {@link PlanReviewCard} /
 * {@link EscalationCards} / {@link ApprovalPrompt} / {@link ResumePrompt} /
 * {@link RetryBanner} / {@link RecoveryActions} / {@link BackgroundTaskCard}), reused
 * verbatim, so a decision read / made / 救火 / 应用 here is identical to one in chat and
 * folds through the very same service + SSE (no second data path — 设计 §二 单一数据源).
 *
 * Why every scope lives here: in canvas mode `ChatView` + `InlineTeamGraph` +
 * `MessageList` are unmounted, so their conversation-level approval / resume /
 * transport-retry prompts, the team strip's 救火行, and the timeline's 后台云端任务
 * cards would be invisible (unactionable) without this. The turn-level cards +
 * recovery scope to the focused turn (`message` + projected `execution`); approval /
 * resume / RetryBanner / 后台任务 are self-contained (own store + active conversation)
 * so they ride along regardless of `message`. `interactive` is the focused turn's
 * live, non-terminal state; a reloaded / ended turn renders its cards as passive
 * records. {@link useCommandRegion} derives all of this live from stores (the canvas
 * only publishes `active` + the focused message id via {@link useCommandPanelStore})
 * and owns the auto-surface; 后台云端任务 是 非阻塞的「另一类」, so it renders last and
 * never inflates the 待你拍板 decision count.
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
  // 交互式逐轮辩论 (opt-in, §逐轮交互): a round boundary awaiting the user counts too.
  for (const d of execution?.debateDecisions ?? [])
    if (d.status === "pending") n++;
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

/** Everything {@link CommandRegion} renders, derived live by {@link useCommandRegion}. */
export interface CommandRegionData {
  /** Whether the region has anything actionable to show (canvas mode + ≥1 item). */
  show: boolean;
  /** Folded to the header strip (badge still visible). */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Focused turn (turn-level cards + 救火 scope); absent for a no-team-turn focus. */
  message?: Message;
  /** Focused turn's projected execution — gates / describes the 救火行. */
  execution: Execution | null;
  conversationId: string | null;
  /** Focused turn is live & non-terminal — its cards are actionable vs passive records. */
  interactive: boolean;
  /** Pending DECISION count for the badge (turn-level + conversation-level approval/resume). */
  pending: number;
}

/**
 * Drive the 指挥台 region from stores. Turn focus is a canvas concept, so the host
 * {@link import("./ConversationCanvas")} publishes `active` + the focused message id
 * via {@link useCommandPanelStore}; everything else (the focused turn's message +
 * projected execution, the conversation-level approval / resume / 救火 / 后台云端任务
 * signals) is derived LIVE here — no snapshot copy, single data source. Owns the
 * auto-surface: a brand-new actionable item opens the dock (without switching the
 * active tab, so a run-detail the user is reading stays put) and re-expands the
 * region; switching focus re-expands too, so a fresh decision is never left folded.
 */
export function useCommandRegion(): CommandRegionData {
  const active = useCommandPanelStore((s) => s.active);
  const focusedMessageId = useCommandPanelStore((s) => s.focusedMessageId);
  const collapsed = useCommandPanelStore((s) => s.collapsed);
  const setCollapsed = useCommandPanelStore((s) => s.setCollapsed);

  const conversationId = useConversationStore((s) => s.currentConversationId);
  const messages = useActiveMessages();
  const message = useMemo(
    () => messages.find((m) => m.id === focusedMessageId),
    [messages, focusedMessageId],
  );
  const execution = useMessageExecution(focusedMessageId);
  const convError = useActiveError();
  const approvalCount = useApprovalStore(
    (s) => s.pending.filter((p) => p.conversationId === conversationId).length,
  );
  const resumeCount = usePausedTurnStore(
    (s) => s.pending.filter((p) => p.conversationId === conversationId).length,
  );
  const backgroundCount = useBackgroundTasks(conversationId).length;

  const turnDecisions = countPendingDecisions(message, execution);
  const pending = turnDecisions + approvalCount + resumeCount;
  const firefighting = !!convError || isTurnRecoverable(execution);
  // 后台云端任务 是 非阻塞的「另一类」: it keeps the region present but never inflates the
  // 待你拍板 badge (`pending`); only `actionable` (presence) counts it.
  const actionable = pending + (firefighting ? 1 : 0) + backgroundCount;
  const show = active && actionable > 0;

  // Auto-surface (子决策 3): a brand-new actionable item opens the dock + re-expands
  // the region — but never switches the active tab (子决策 A), so a run-detail the user
  // is reading stays put and the region just hangs above it. Reset to 0 while inactive
  // (chat mode) so re-entering the canvas with pending work surfaces it afresh.
  const prevActionable = useRef(0);
  useEffect(() => {
    if (active && actionable > prevActionable.current) {
      useSidePanelStore.getState().openPanel();
      setCollapsed(false);
    }
    prevActionable.current = active ? actionable : 0;
  }, [active, actionable, setCollapsed]);

  // Re-arm on focus switch: another turn's decisions deserve a fresh, open look.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to focus change, not setter identity.
  useEffect(() => {
    setCollapsed(false);
  }, [focusedMessageId]);

  return {
    show,
    collapsed,
    setCollapsed,
    message,
    execution,
    conversationId,
    interactive: message?.isStreaming ?? false,
    pending,
  };
}

/**
 * The 指挥台 region pinned to the TOP of the unified side panel (前端UX设计.md §6.2 ·
 * §十): a collapsible header strip + the boss's pending-decision / 救火 / 后台云端任务
 * cards. Capped to ~55% of the panel's content height with its own scroll (子决策 P1)
 * so the tab body below always keeps usable space; collapse folds it to just the
 * header (the「待你拍板」badge stays visible). Closing the whole dock is the side
 * panel's job (its X / Ctrl+I) — the region only collapses, never closes. Props come
 * from {@link useCommandRegion}; render only when its `show` is true.
 */
export function CommandRegion({
  collapsed,
  setCollapsed,
  message,
  execution,
  conversationId,
  interactive,
  pending,
}: CommandRegionData) {
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
    <section className="flex max-h-[55%] shrink-0 flex-col border-b border-border bg-card">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
        <Gavel size={15} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          指挥台
          {pending > 0 && (
            <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
              {pending}
            </span>
          )}
        </span>
        <IconButton
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "展开指挥台" : "折叠指挥台"}
          aria-expanded={!collapsed}
          title={collapsed ? "展开指挥台" : "折叠指挥台"}
        >
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </IconButton>
      </div>
      {!collapsed && (
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
            {message && (
              <DebateRoundDecisionCards
                messageId={message.id}
                conversationId={conversationId}
                interactive={interactive}
              />
            )}
          </div>
          {/* 后台云端任务 (handoff jobs, 非阻塞 · 跨对话的另一类): last, below every
              blocking decision. */}
          <CanvasBackgroundTasks conversationId={conversationId} />
        </div>
      )}
    </section>
  );
}

/**
 * Self-contained feed of this conversation's 后台云端任务 (handoff jobs, 双模式工作区
 * 交接「方案 B」). In chat mode these merge into the message timeline ({@link
 * import("../chat/MessageList")}); in canvas mode that timeline is unmounted, so the
 * 指挥台 is the only place they can be seen / 应用 (前端UX设计.md §6.2). The host {@link
 * import("./ConversationCanvas")} runs `useBackgroundTasksSync` (it stays mounted
 * while this panel may be closed, so the job list keeps polling); this just reads the
 * already-synced store + the bound local root id (which a succeeded job's inline
 * 评审 needs to write the result back). Renders nothing when there are no jobs. */
function CanvasBackgroundTasks({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const tasks = useBackgroundTasks(conversationId);
  const rootId = useWorkspaceRootId(conversationId);
  if (tasks.length === 0) return null;
  return (
    <div className="mx-4 mt-2 space-y-2">
      {tasks.map((job) => (
        <BackgroundTaskCard key={job.id} job={job} rootId={rootId} />
      ))}
    </div>
  );
}
