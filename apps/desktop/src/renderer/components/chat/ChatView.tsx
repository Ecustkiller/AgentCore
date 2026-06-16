import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useConversations,
  useRenameConversation,
} from "@/hooks/useConversations";
import { notifyError } from "@/lib/toast";
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
  Pencil,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";
import { ResumePrompt } from "./ResumePrompt";

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

/**
 * Slim header above the conversation showing its title, with inline rename
 * (单会话页重命名). The chat view is otherwise headerless, so this is the in-place
 * rename entry (the sidebar list is the other one). Renders nothing for a brand-new
 * draft (no id) or a conversation not in the cache, so the empty
 * "今天想解决什么问题？" state stays clean. The title is read from — and the rename
 * written back to — the shared grouped cache, so an auto-generated title
 * (title_generated) and a sidebar rename both reflect here live. Double-click the
 * bar or click the pencil to edit; Enter commits, Esc cancels.
 */
function ConversationHeader() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const conversations = useConversations();
  const renameMutation = useRenameConversation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);

  const conv = conversationId
    ? conversations.find((c) => c.id === conversationId)
    : undefined;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!conversationId || !conv) return null;

  const startEdit = () => {
    setDraft(conv.title);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    // No-op on an empty or unchanged title; optimistic rename + rollback live in
    // the mutation, so a failed write reverts and we only add a toast here.
    if (!title || title === conv.title) return;
    renameMutation.mutate(
      { id: conv.id, title },
      { onError: (err) => notifyError(err, "重命名失败") },
    );
  };

  if (editing) {
    return (
      <div className="flex h-11 shrink-0 items-center border-b border-border px-6 pr-14">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              skipBlurRef.current = true;
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (skipBlurRef.current) {
              skipBlurRef.current = false;
              return;
            }
            commit();
          }}
          className="h-7 min-w-0 flex-1 rounded-md bg-accent px-2 text-sm font-medium text-foreground focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div
      onDoubleClick={startEdit}
      className="group/title flex h-11 shrink-0 items-center gap-1 border-b border-border px-6 pr-14"
    >
      <span className="truncate text-sm font-medium text-foreground">
        {conv.title}
      </span>
      <SimpleTooltip label="重命名对话">
        <button
          type="button"
          onClick={startEdit}
          aria-label="重命名对话"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/title:opacity-100"
        >
          <Pencil size={13} />
        </button>
      </SimpleTooltip>
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
      <ConversationHeader />
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
        <ResumePrompt />
        <ApprovalPrompt />
        <RetryBanner />
        <MessageInput />
      </div>
    </div>
  );
}
