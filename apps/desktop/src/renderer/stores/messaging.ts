import {
  type ChatMessageDetail,
  type ChatSummary,
  sendMessage as apiSendMessage,
  listChats,
  listMessages,
  markRead,
  messagingErrorMessage,
} from "@/services/messaging";
import { useAuthStore } from "@/stores/auth";
import { create } from "zustand";

/**
 * 消息 page (找人 IM) client state — deliberately separate from the AI
 * `conversation` store (消息IM.md §一: reuse UI + realtime, not the same data).
 *
 * Holds the chat list, per-chat message slices (loaded lazily on open — the
 * "离线补偿 on open" model), the active chat, and a transient send error. The
 * realtime firehose (services/realtime.ts, stage D) feeds new messages in via
 * {@link MessagingState.applyIncoming}; until it is wired, the store is fully
 * usable over REST alone.
 */

const EMPTY_MESSAGES: ChatMessageDetail[] = [];

/** A human-readable list-row preview for a message (non-text shows a kind tag). */
function previewOf(message: ChatMessageDetail): string {
  switch (message.content_type) {
    case "image":
      return "[图片]";
    case "file":
      return "[文件]";
    case "system_card":
      return "[通知]";
    default:
      return message.content ?? "";
  }
}

/**
 * Apply a message to the chat list: refresh the row's preview/time, optionally
 * bump its unread count, and move it to the front (recent-first). A chat not in
 * the list is left untouched (the caller refetches to pull in a new request).
 */
function bumpChat(
  chats: ChatSummary[],
  chatId: string,
  preview: string,
  at: string,
  incUnread: number,
): ChatSummary[] {
  const idx = chats.findIndex((c) => c.id === chatId);
  if (idx === -1) return chats;
  const chat = chats[idx];
  const updated: ChatSummary = {
    ...chat,
    last_message_preview: preview,
    last_message_at: at,
    unread: chat.unread + incUnread,
  };
  return [updated, ...chats.filter((_, i) => i !== idx)];
}

interface MessagingState {
  chats: ChatSummary[];
  chatsLoaded: boolean;
  loadingChats: boolean;
  /** Loaded message slices keyed by chat id (oldest first); absent until opened. */
  messagesByChat: Record<string, ChatMessageDetail[]>;
  loadingMessages: Record<string, boolean>;
  activeChatId: string | null;
  /** Transient zh error for the last failed send, or null. */
  sendError: string | null;

  fetchChats: () => Promise<void>;
  /** Make a chat active, load its history, then advance its read cursor. */
  openChat: (chatId: string) => Promise<void>;
  setActiveChat: (chatId: string | null) => void;
  loadMessages: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, content: string) => Promise<void>;
  markChatRead: (chatId: string) => Promise<void>;
  /** Merge or prepend a chat the client just learned about (e.g. a new dm). */
  upsertChat: (chat: ChatSummary) => void;
  /** Ingest a realtime message (from the firehose): merge + unread + reorder. */
  applyIncoming: (chatId: string, message: ChatMessageDetail) => void;
  clearSendError: () => void;
}

export const useMessagingStore = create<MessagingState>((set, get) => ({
  chats: [],
  chatsLoaded: false,
  loadingChats: false,
  messagesByChat: {},
  loadingMessages: {},
  activeChatId: null,
  sendError: null,

  fetchChats: async () => {
    set({ loadingChats: true });
    try {
      const chats = await listChats();
      set({ chats, chatsLoaded: true, loadingChats: false });
    } catch {
      // Best-effort: keep whatever the list already had and stop the spinner.
      set({ loadingChats: false });
    }
  },

  openChat: async (chatId) => {
    set({ activeChatId: chatId });
    await get().loadMessages(chatId);
    await get().markChatRead(chatId);
  },

  setActiveChat: (chatId) => set({ activeChatId: chatId }),

  loadMessages: async (chatId) => {
    if (get().loadingMessages[chatId]) return;
    set((s) => ({
      loadingMessages: { ...s.loadingMessages, [chatId]: true },
    }));
    try {
      const page = await listMessages(chatId, 1, 50);
      set((s) => ({
        messagesByChat: { ...s.messagesByChat, [chatId]: page.messages },
        loadingMessages: { ...s.loadingMessages, [chatId]: false },
      }));
    } catch {
      set((s) => ({
        loadingMessages: { ...s.loadingMessages, [chatId]: false },
      }));
    }
  },

  sendMessage: async (chatId, content) => {
    const text = content.trim();
    if (!text) return;

    const clientMsgId = crypto.randomUUID();
    const me = useAuthStore.getState().user;
    const optimistic: ChatMessageDetail = {
      id: `local:${clientMsgId}`,
      chat_id: chatId,
      sender_user_id: me?.id ?? null,
      sender_type: "user",
      content: text,
      content_type: "text",
      attachments: [],
      payload: null,
      reply_to_message_id: null,
      created_at: new Date().toISOString(),
    };

    set((s) => ({
      messagesByChat: {
        ...s.messagesByChat,
        [chatId]: [...(s.messagesByChat[chatId] ?? []), optimistic],
      },
      chats: bumpChat(
        s.chats,
        chatId,
        previewOf(optimistic),
        optimistic.created_at,
        0,
      ),
      sendError: null,
    }));

    try {
      const saved = await apiSendMessage(chatId, {
        content: text,
        clientMsgId,
      });
      // Swap the optimistic twin for the stored message. The firehose also
      // delivers this same message (sender included, multi-device) — dedupe by
      // id keeps it from doubling up.
      set((s) => {
        const list = s.messagesByChat[chatId] ?? [];
        const withoutOptimistic = list.filter((m) => m.id !== optimistic.id);
        const exists = withoutOptimistic.some((m) => m.id === saved.id);
        return {
          messagesByChat: {
            ...s.messagesByChat,
            [chatId]: exists
              ? withoutOptimistic
              : [...withoutOptimistic, saved],
          },
        };
      });
    } catch (err) {
      // Roll back the optimistic message and surface a zh error for the composer.
      set((s) => ({
        messagesByChat: {
          ...s.messagesByChat,
          [chatId]: (s.messagesByChat[chatId] ?? []).filter(
            (m) => m.id !== optimistic.id,
          ),
        },
        sendError: messagingErrorMessage(err, "发送失败，请重试"),
      }));
    }
  },

  markChatRead: async (chatId) => {
    // Clear the local unread badge immediately (optimistic), then persist the
    // cursor to the newest known message. No messages yet → just clear the badge.
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, unread: 0 } : c)),
    }));
    const list = get().messagesByChat[chatId];
    const last = list?.[list.length - 1];
    if (!last || last.id.startsWith("local:")) return;
    try {
      await markRead(chatId, last.id);
    } catch {
      /* best-effort — the badge already cleared locally */
    }
  },

  upsertChat: (chat) =>
    set((s) => {
      const idx = s.chats.findIndex((c) => c.id === chat.id);
      if (idx === -1) return { chats: [chat, ...s.chats] };
      const next = [...s.chats];
      next[idx] = { ...next[idx], ...chat };
      return { chats: next };
    }),

  applyIncoming: (chatId, message) => {
    const known = get().chats.some((c) => c.id === chatId);
    set((s) => {
      const list = s.messagesByChat[chatId];
      // Only merge into an already-loaded slice; an unopened chat re-syncs from
      // the server when the user opens it (离线补偿 on open). Dedupe by id.
      const messagesByChat =
        list && !list.some((m) => m.id === message.id)
          ? { ...s.messagesByChat, [chatId]: [...list, message] }
          : s.messagesByChat;

      const me = useAuthStore.getState().user?.id ?? null;
      const isMine =
        message.sender_user_id !== null && message.sender_user_id === me;
      const incUnread = s.activeChatId === chatId || isMine ? 0 : 1;
      const chats = bumpChat(
        s.chats,
        chatId,
        previewOf(message),
        message.created_at,
        incUnread,
      );
      return { messagesByChat, chats };
    });
    // A message for a chat we don't know yet (a new incoming request): pull the
    // list so the row appears. Done outside set() to avoid a nested update.
    if (!known) void get().fetchChats();
  },

  clearSendError: () => set({ sendError: null }),
}));

// --- Selectors ---

export const useChats = (): ChatSummary[] => useMessagingStore((s) => s.chats);

export function useActiveMessages(): ChatMessageDetail[] {
  return useMessagingStore((s) =>
    s.activeChatId
      ? (s.messagesByChat[s.activeChatId] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
}

export function useActiveChat(): ChatSummary | null {
  return useMessagingStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId) ?? null,
  );
}

/** Total unread across non-muted chats — drives the sidebar 消息 badge. */
export function useUnreadTotal(): number {
  return useMessagingStore((s) =>
    s.chats.reduce((sum, c) => sum + (c.muted ? 0 : c.unread), 0),
  );
}
