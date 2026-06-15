import { useStickToBottom } from "@/lib/useStickToBottom";
import { useAuthStore } from "@/stores/auth";
import {
  useActiveChat,
  useActiveMessages,
  useMessagingStore,
} from "@/stores/messaging";
import { ArrowDown } from "lucide-react";
import { ChatBubble } from "./ChatBubble";
import { ChatComposer } from "./ChatComposer";
import { avatarInitial, chatDisplayName } from "./chatDisplay";

interface Props {
  chatId: string;
}

/** Right pane: the active chat's message thread + composer. */
export function ChatThread({ chatId }: Props) {
  const chat = useActiveChat();
  const messages = useActiveMessages();
  const loading = useMessagingStore((s) => s.loadingMessages[chatId] ?? false);
  const myId = useAuthStore((s) => s.user?.id ?? null);

  const last = messages[messages.length - 1];
  const contentKey = last ? `${last.id}-${messages.length}` : "";
  const { scrollRef, atBottom, jumpToBottom } = useStickToBottom(
    contentKey,
    chatId,
  );

  const name = chat ? chatDisplayName(chat) : "";
  const hasMessages = messages.length > 0;
  // viewer.state === pending means someone opened this dm with us and we have
  // not replied yet — a message request (replying accepts it, 消息IM.md §五).
  const isRequest = chat?.state === "pending";

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
          {avatarInitial(name || "?")}
        </span>
        <span className="truncate text-base font-medium text-foreground">
          {name}
        </span>
      </div>

      {isRequest && (
        <div className="mx-4 mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          这是一条消息请求，回复即代表接受。
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          {hasMessages ? (
            <div className="flex flex-col gap-2 px-4 py-4">
              {messages.map((m) => (
                <ChatBubble
                  key={m.id}
                  message={m}
                  mine={m.sender_user_id != null && m.sender_user_id === myId}
                />
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">
                {loading ? "加载中…" : "还没有消息，发送第一条消息吧"}
              </p>
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

      <ChatComposer chatId={chatId} />
    </div>
  );
}
