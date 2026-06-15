import { SimpleTooltip } from "@/components/ui/tooltip";
import { useChatScroll } from "@/lib/useChatScroll";
import {
  loadLatestWindow,
  loadNewerMessages,
  loadOlderMessages,
} from "@/services/messages";
import {
  useActiveError,
  useActiveErrorAction,
  useActiveHasMoreAfter,
  useActiveHasMoreBefore,
  useActiveLoadingNewer,
  useActiveLoadingOlder,
  useActiveMessages,
  useActiveRetry,
  useConversationStore,
} from "@/stores/conversation";
import {
  AlertTriangle,
  ArrowDown,
  KeyRound,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";

/**
 * Banner for a failed turn (send / regenerate transport error), shown just above
 * the input. The retry closure re-runs that exact turn; the optional action routes
 * the user to fix the cause (e.g. "去配置" → model config for a missing BYOK key);
 * dismissing only hides the banner.
 */
function RetryBanner() {
  const error = useActiveError();
  const retry = useActiveRetry();
  const action = useActiveErrorAction();
  const clearError = useConversationStore((s) => s.clearError);
  const navigate = useNavigate();
  if (!error) return null;

  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle size={15} className="shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            clearError();
            navigate(action.href);
          }}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
        >
          <KeyRound size={13} />
          {action.label}
        </button>
      )}
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
  const hasMoreBefore = useActiveHasMoreBefore();
  const hasMoreAfter = useActiveHasMoreAfter();
  const loadingOlder = useActiveLoadingOlder();
  const loadingNewer = useActiveLoadingNewer();

  const onLoadOlder = useCallback(() => {
    if (conversationId) void loadOlderMessages(conversationId);
  }, [conversationId]);
  const onLoadNewer = useCallback(() => {
    if (conversationId) void loadNewerMessages(conversationId);
  }, [conversationId]);
  const onJumpToLatest = useCallback(() => {
    if (conversationId) void loadLatestWindow(conversationId);
  }, [conversationId]);

  // Re-run the auto-follow whenever the newest turn grows — both its answer and
  // its live reasoning stream — so the view tracks the model while it thinks.
  const last = messages[messages.length - 1];
  const contentKey = last
    ? `${last.id}-${last.content.length}-${last.reasoning?.length ?? 0}`
    : "";
  const { scrollRef, atBottom, jumpToBottom } = useChatScroll({
    messages,
    resetKey: conversationId,
    contentKey,
    hasMoreBefore,
    hasMoreAfter,
    loadingOlder,
    loadingNewer,
    onLoadOlder,
    onLoadNewer,
    onJumpToLatest,
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Scrollable message area (scrollbar at container edge, content centered).
          The relative wrapper anchors the floating 回到底部 button to the viewport
          so it stays put instead of scrolling away with the messages. */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          {hasMessages ? (
            <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-4">
              {/* Top sentinel: spins while the previous page loads (scroll-up
                  infinite scroll); the window anchors so the view stays put. */}
              {(loadingOlder || hasMoreBefore) && (
                <div className="flex justify-center py-2">
                  <Loader2
                    size={16}
                    className={`text-muted-foreground ${
                      loadingOlder ? "animate-spin" : "opacity-0"
                    }`}
                  />
                </div>
              )}
              <MessageList />
              {/* Bottom sentinel: spins while a newer page loads (only reachable
                  after a search-hit jump left newer history unloaded). */}
              {loadingNewer && (
                <div className="flex justify-center py-2">
                  <Loader2
                    size={16}
                    className="animate-spin text-muted-foreground"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-2xl font-medium text-foreground">
                  今天想解决什么问题？
                </p>
              </div>
            </div>
          )}
        </div>
        {hasMessages && !atBottom && (
          <SimpleTooltip label="回到底部">
            <button
              type="button"
              onClick={jumpToBottom}
              aria-label="回到底部"
              className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-colors hover:text-foreground"
            >
              <ArrowDown size={16} />
            </button>
          </SimpleTooltip>
        )}
      </div>

      {/* Bottom input area */}
      <div className="mx-auto w-full max-w-3xl">
        <ApprovalPrompt />
        <RetryBanner />
        <MessageInput />
      </div>
    </div>
  );
}
