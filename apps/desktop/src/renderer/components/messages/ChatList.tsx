import { NarrowMenuButton } from "@/components/layout/NarrowMenuButton";
import { EmptyHint, IconButton, SearchField } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useNarrowLayoutState } from "@/lib/narrowLayout";
import { cn } from "@/lib/utils";
import {
  useChats,
  useIncomingFriendRequestCount,
  useMessagingStore,
} from "@/stores/messaging";
import { BookUser, SquarePen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ChatListItem } from "./ChatListItem";
import { chatDisplayName } from "./chatDisplay";

interface Props {
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  onOpenContacts: () => void;
  className?: string;
}

/** Left pane: the chat list with a header, a local filter, and empty states. */
export function ChatList({
  activeChatId,
  onSelect,
  onNewChat,
  onOpenContacts,
  className,
}: Props) {
  const chats = useChats();
  const loading = useMessagingStore((s) => s.loadingChats);
  const loaded = useMessagingStore((s) => s.chatsLoaded);
  const incomingCount = useIncomingFriendRequestCount();
  const { isNarrow } = useNarrowLayoutState();
  const [query, setQuery] = useState("");

  // Hydrate the list once; the firehose keeps it fresh thereafter (stage D).
  useEffect(() => {
    if (!useMessagingStore.getState().chatsLoaded) {
      void useMessagingStore.getState().fetchChats();
    }
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => chatDisplayName(c).toLowerCase().includes(q));
  }, [chats, query]);

  return (
    <aside
      className={cn(
        "flex w-72 shrink-0 flex-col border-r border-border",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3",
          isNarrow &&
            "h-12 border-b border-border bg-card px-2 pt-[env(safe-area-inset-top)]",
        )}
      >
        {isNarrow && <NarrowMenuButton />}
        <span className="min-w-0 flex-1 text-base font-medium text-foreground">
          消息
        </span>
        <div className="flex items-center gap-0.5">
          <SimpleTooltip label="通讯录">
            <IconButton
              aria-label={
                incomingCount > 0
                  ? `通讯录，${incomingCount} 条新的朋友申请`
                  : "通讯录"
              }
              onClick={onOpenContacts}
              className="relative [-webkit-app-region:no-drag]"
            >
              <BookUser size={16} />
              {incomingCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary" />
              )}
            </IconButton>
          </SimpleTooltip>
          <SimpleTooltip label="查找用户">
            <IconButton
              aria-label="查找用户"
              onClick={onNewChat}
              className="[-webkit-app-region:no-drag]"
            >
              <SquarePen size={16} />
            </IconButton>
          </SimpleTooltip>
        </div>
      </div>

      {chats.length > 0 && (
        <div className="px-3 pb-2">
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="筛选会话…"
            aria-label="筛选会话"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!loaded && loading ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            加载中…
          </p>
        ) : filtered.length === 0 ? (
          <EmptyHint
            className="py-10"
            title={chats.length === 0 ? "还没有会话" : "没有匹配的会话"}
          />
        ) : (
          <div className="space-y-0.5">
            {filtered.map((c) => (
              <ChatListItem
                key={c.id}
                chat={c}
                active={c.id === activeChatId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
