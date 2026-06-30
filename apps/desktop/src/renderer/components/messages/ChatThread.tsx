import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useStickToBottom } from "@/lib/useStickToBottom";
import { useAuthStore } from "@/stores/auth";
import {
  useActiveChat,
  useActiveMessages,
  useChatMembers,
  useMessagingStore,
} from "@/stores/messaging";
import { ArrowDown, Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ChatBubble } from "./ChatBubble";
import { ChatComposer } from "./ChatComposer";
import { GroupInfoDialog } from "./GroupInfoDialog";
import { avatarInitial, chatDisplayName } from "./chatDisplay";

interface Props {
  chatId: string;
}

/** Right pane: the active chat's message thread + composer. */
export function ChatThread({ chatId }: Props) {
  const chat = useActiveChat();
  const messages = useActiveMessages();
  const members = useChatMembers(chatId);
  const loading = useMessagingStore((s) => s.loadingMessages[chatId] ?? false);
  const loadMembers = useMessagingStore((s) => s.loadMembers);
  const myId = useAuthStore((s) => s.user?.id ?? null);

  const isGroup = chat?.type === "group";
  const [infoOpen, setInfoOpen] = useState(false);

  // Group threads label each message with its sender, so they need the roster;
  // load it when a group opens (dms render the single peer's name in the header).
  useEffect(() => {
    if (isGroup) void loadMembers(chatId);
  }, [isGroup, chatId, loadMembers]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.id, m.display_name || m.username);
    return map;
  }, [members]);

  const last = messages[messages.length - 1];
  const contentKey = last ? `${last.id}-${messages.length}` : "";
  const { scrollRef, atBottom, jumpToBottom } = useStickToBottom(
    contentKey,
    chatId,
  );

  const name = chat ? chatDisplayName(chat) : "";
  const memberCount = isGroup && members.length > 0 ? members.length : null;
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
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-base font-medium text-foreground">
            {name}
          </span>
          {memberCount && (
            <span className="text-xs text-muted-foreground">
              {memberCount} 名成员
            </span>
          )}
        </span>
        {isGroup && (
          <SimpleTooltip label="群信息">
            <IconButton
              size="md"
              onClick={() => setInfoOpen(true)}
              aria-label="群信息"
              className="ml-auto shrink-0"
            >
              <Info size={18} />
            </IconButton>
          </SimpleTooltip>
        )}
      </div>

      {isRequest && (
        <div className="mx-4 mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          这是一条消息请求，回复即代表接受。
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          {hasMessages ? (
            <div className="flex flex-col gap-2 px-4 py-4">
              {messages.map((m) => {
                const mine =
                  m.sender_user_id != null && m.sender_user_id === myId;
                const senderName =
                  isGroup && !mine && m.sender_user_id
                    ? (nameById.get(m.sender_user_id) ?? "成员")
                    : undefined;
                return (
                  <ChatBubble
                    key={m.id}
                    message={m}
                    mine={mine}
                    senderName={senderName}
                  />
                );
              })}
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

      <ChatComposer chatId={chatId} />

      {isGroup && (
        <GroupInfoDialog
          chatId={chatId}
          open={infoOpen}
          onClose={() => setInfoOpen(false)}
        />
      )}
    </div>
  );
}
