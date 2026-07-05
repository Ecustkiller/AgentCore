import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useChatScroll } from "@/lib/useChatScroll";
import {
  loadLatestWindow,
  loadNewerMessages,
  loadOlderMessages,
} from "@/services/messages";
import {
  useActiveGenerating,
  useActiveHasMoreAfter,
  useActiveHasMoreBefore,
  useActiveLoadingNewer,
  useActiveLoadingOlder,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import { ArrowDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { ConversationOutline } from "./ConversationOutline";
import { FindBar } from "./FindBar";
import { FollowupChips } from "./FollowupChips";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";
import { ResumePrompt } from "./ResumePrompt";
import { RetryBanner } from "./RetryBanner";
import { StreamingIndicator } from "./StreamingIndicator";

export function ChatView() {
  const messages = useActiveMessages();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const isGenerating = useActiveGenerating();
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

  // 会话内查找: Ctrl/Cmd+F opens the find bar (`f` is free in GLOBAL_SHORTCUTS). Scoped to
  // when a non-empty conversation is on screen — ChatView only mounts then anyway. Esc /
  // the ✕ close it (handled inside FindBar).
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "f"
      ) {
        if (!hasMessages) return;
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasMessages]);
  useEffect(() => {
    if (!hasMessages && findOpen) setFindOpen(false);
  }, [hasMessages, findOpen]);

  // Re-run the auto-follow whenever the newest turn grows — both its answer and
  // its live reasoning stream — so the view tracks the model while it thinks.
  const last = messages[messages.length - 1];
  const contentKey = last
    ? `${last.id}-${last.content.length}-${last.reasoning?.length ?? 0}`
    : "";

  // 下一步推荐 chips: surface the latest finished assistant turn's followups directly above
  // the composer — the 「what next」 affordance belongs where you type and stays put regardless
  // of scroll. Persisted (messages.followups) so a refresh replays them; a NEW turn retires the
  // prior turn's chips (they leave the last-message slot). FollowupChips renders nothing if empty.
  const followups =
    !isGenerating && last?.role === "assistant" && !last.isStreaming
      ? (last.followups ?? [])
      : [];
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
        <FindBar open={findOpen} onClose={() => setFindOpen(false)} />
        <ConversationOutline />
        <div ref={scrollRef} className="h-full overflow-y-auto">
          {hasMessages ? (
            <div className="mx-auto w-full max-w-3xl space-y-4 px-6 pb-4 pt-10">
              {/* Headerless chat view: the top padding keeps the first message
                  clear of the floating side-panel toggle (top-right of the pane,
                  set in ConversationPage). */}
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
            <IconButton
              size="md"
              onClick={jumpToBottom}
              aria-label="回到底部"
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card text-muted-foreground shadow-md hover:text-foreground"
            >
              <ArrowDown size={16} />
            </IconButton>
          </SimpleTooltip>
        )}
      </div>

      {/* Bottom input area */}
      <div className="mx-auto w-full max-w-3xl">
        <ResumePrompt />
        <ApprovalPrompt />
        <RetryBanner />
        <FollowupChips followups={followups} />
        <StreamingIndicator />
        <MessageInput />
      </div>
    </div>
  );
}
