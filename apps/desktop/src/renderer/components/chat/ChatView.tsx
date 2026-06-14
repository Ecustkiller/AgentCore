import { formatCompact, formatCost } from "@/lib/format";
import {
  useActiveError,
  useActiveMessages,
  useActiveRetry,
  useConversationStore,
} from "@/stores/conversation";
import { useUsageStore } from "@/stores/usage";
import { AlertTriangle, RotateCw, X } from "lucide-react";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";

/**
 * 对话累计 (§7.3C) — a very faint caption at the top of the conversation showing
 * its cumulative spend, with a hover tooltip for the power detail (token 合计 +
 * 回合数). Seeded from the ledger on open and bumped live by each turn, so it is
 * always current. Renders nothing until there is real spend (§7.5: 无花销不显).
 */
function ConversationCostCaption() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const summary = useUsageStore((s) =>
    conversationId ? s.conversationCosts[conversationId] : undefined,
  );
  if (!summary || summary.total <= 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-4xl justify-end px-6 pt-2">
      <span
        title={`token ${formatCompact(summary.tokens)} · ${summary.turns} 回合`}
        className="cursor-default text-xs text-muted-foreground/60"
      >
        本对话 {formatCost(summary.total, cnyPerUsd)}
      </span>
    </div>
  );
}

/**
 * Banner for a failed turn (send / regenerate transport error), shown just above
 * the input. The retry closure is supplied by the failing call and re-runs that
 * exact turn; dismissing only hides the banner.
 */
function RetryBanner() {
  const error = useActiveError();
  const retry = useActiveRetry();
  const clearError = useConversationStore((s) => s.clearError);
  if (!error) return null;

  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle size={15} className="shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      {retry && (
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
        >
          <RotateCw size={13} />
          重试
        </button>
      )}
      <button
        type="button"
        onClick={() => clearError()}
        aria-label="关闭"
        className="shrink-0 text-destructive/70 hover:text-destructive"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ChatView() {
  const messages = useActiveMessages();
  const hasMessages = messages.length > 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ConversationCostCaption />
      {/* Scrollable message area (scrollbar at container edge, content centered) */}
      <div className="flex-1 overflow-y-auto">
        {hasMessages ? (
          <div className="mx-auto w-full max-w-4xl space-y-4 px-6 py-4">
            <MessageList />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-foreground">
                AgentCore
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Multi-Agent AI 工作台
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                输入消息开始对话
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Bottom input area */}
      <div className="mx-auto w-full max-w-4xl">
        <ApprovalPrompt />
        <RetryBanner />
        <MessageInput />
      </div>
    </div>
  );
}
