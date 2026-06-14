import { create } from "zustand";

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
}

/** 附件在消息气泡上的展示元信息（不含正文，正文仅发送时携带）。 */
export interface MessageAttachmentMeta {
  id: string;
  name: string;
  path: string;
  truncated: boolean;
  /** file=单文件；dir=目录（附带文件清单）。缺省视为 file（兼容旧数据）。 */
  kind?: "file" | "dir";
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 模型思考过程（思考档位下的 reasoning_content）；流式与历史回放共用。 */
  reasoning?: string;
  createdAt: string;
  executionId: string | null;
  isStreaming: boolean;
  attachments?: MessageAttachmentMeta[];
}

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];
  isGenerating: boolean;
  /** AbortController for the in-flight turn (send or regenerate), if any. */
  abort: AbortController | null;
  /** User-facing error for the last failed turn, with a one-click retry. */
  error: string | null;
  retry: (() => void) | null;

  setConversations: (conversations: Conversation[]) => void;
  setCurrentConversation: (id: string | null) => void;
  removeConversation: (id: string) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  appendToLastMessage: (chunk: string) => void;
  appendReasoningToLastMessage: (chunk: string) => void;
  createAssistantMessage: () => string;
  finalizeLastMessage: () => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  /** Drop every message after `id` (exclusive). Used by regenerate / edit. */
  truncateAfter: (id: string) => void;
  /** Replace the optimistic id of the last user message with the backend's
   * authoritative id (from `turn_saved`), so regenerate / edit / retry target
   * the real row. */
  reconcileLastTurn: (userMessageId: string) => void;
  setGenerating: (v: boolean) => void;
  clearMessages: () => void;
  switchConversation: (id: string | null) => void;
  renameConversation: (id: string, title: string) => void;
  /** Register the controller for the current turn (cleared when it ends). */
  setAbort: (a: AbortController | null) => void;
  /** Abort the in-flight turn and finalize the streaming message. */
  stopGeneration: () => void;
  setError: (message: string, retry: (() => void) | null) => void;
  clearError: () => void;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isGenerating: false,
  abort: null,
  error: null,
  retry: null,

  setConversations: (conversations) => set({ conversations }),

  setCurrentConversation: (id) => set({ currentConversationId: id }),

  removeConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      currentConversationId:
        state.currentConversationId === id ? null : state.currentConversationId,
    })),

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  appendToLastMessage: (chunk) =>
    set((state) => {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last) {
        messages[messages.length - 1] = {
          ...last,
          content: last.content + chunk,
        };
      }
      return { messages };
    }),

  appendReasoningToLastMessage: (chunk) =>
    set((state) => {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last) {
        messages[messages.length - 1] = {
          ...last,
          reasoning: (last.reasoning ?? "") + chunk,
        };
      }
      return { messages };
    }),

  createAssistantMessage: () => {
    const id = crypto.randomUUID();
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id,
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          executionId: null,
          isStreaming: true,
        },
      ],
      isGenerating: true,
    }));
    return id;
  },

  finalizeLastMessage: () =>
    set((state) => {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last) {
        messages[messages.length - 1] = { ...last, isStreaming: false };
      }
      return { messages, isGenerating: false };
    }),

  updateMessage: (id, update) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...update } : m,
      ),
    })),

  truncateAfter: (id) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === id);
      if (idx === -1) return {};
      return { messages: state.messages.slice(0, idx + 1) };
    }),

  reconcileLastTurn: (userMessageId) =>
    set((state) => {
      const messages = [...state.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          messages[i] = { ...messages[i], id: userMessageId };
          break;
        }
      }
      return { messages };
    }),

  setGenerating: (v) => set({ isGenerating: v }),

  clearMessages: () => set({ messages: [], isGenerating: false }),

  switchConversation: (id) => {
    get().abort?.abort();
    set({
      currentConversationId: id,
      messages: [],
      isGenerating: false,
      abort: null,
      error: null,
      retry: null,
    });
  },

  renameConversation: (id, title) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c,
      ),
    })),

  setAbort: (a) => set({ abort: a }),

  stopGeneration: () => {
    get().abort?.abort();
    set({ abort: null });
    get().finalizeLastMessage();
  },

  setError: (message, retry) => set({ error: message, retry }),

  clearError: () => set({ error: null, retry: null }),
}));
