import { useStickToBottom } from "@/lib/useStickToBottom";
import {
  useActiveError,
  useActiveMessages,
  useActiveRetry,
  useConversationStore,
} from "@/stores/conversation";
import { AlertTriangle, ArrowDown, RotateCw, X } from "lucide-react";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";

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
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const hasMessages = messages.length > 0;

  // Re-run the auto-follow whenever the newest turn grows — both its answer and
  // its live reasoning stream — so the view tracks the model while it thinks.
  const last = messages[messages.length - 1];
  const contentKey = last
    ? `${last.id}-${last.content.length}-${last.reasoning?.length ?? 0}`
    : "";
  const { scrollRef, atBottom, jumpToBottom } = useStickToBottom(
    contentKey,
    conversationId,
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Scrollable message area (scrollbar at container edge, content centered).
          The relative wrapper anchors the floating 回到底部 button to the viewport
          so it stays put instead of scrolling away with the messages. */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
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
        {hasMessages && !atBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="回到底部"
            title="回到底部"
            className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-colors hover:text-foreground"
          >
            <ArrowDown size={16} />
          </button>
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
