import { create } from "zustand";

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  executionId: string | null;
  isStreaming: boolean;
}

const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: "conv-1",
    title: "实现用户登录模块",
    updatedAt: "2026-06-14T10:00:00Z",
    messageCount: 5,
    lastMessagePreview: "好的，我来帮你设计登录流程…",
  },
  {
    id: "conv-2",
    title: "设计数据库 Schema",
    updatedAt: "2026-06-14T09:30:00Z",
    messageCount: 3,
    lastMessagePreview: null,
  },
  {
    id: "conv-3",
    title: "帮我写个邮件",
    updatedAt: "2026-06-13T15:00:00Z",
    messageCount: 8,
    lastMessagePreview: "以下是邮件草稿…",
  },
  {
    id: "conv-4",
    title: "分析这段代码的性能瓶颈",
    updatedAt: "2026-06-13T12:00:00Z",
    messageCount: 2,
    lastMessagePreview: null,
  },
  {
    id: "conv-5",
    title: "机器学习基础笔记整理",
    updatedAt: "2026-06-12T08:00:00Z",
    messageCount: 12,
    lastMessagePreview: "特征工程是关键步骤…",
  },
];

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];

  setConversations: (conversations: Conversation[]) => void;
  setCurrentConversation: (id: string | null) => void;
  removeConversation: (id: string) => void;
  addMessage: (message: Message) => void;
  appendToLastMessage: (chunk: string) => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: MOCK_CONVERSATIONS,
  currentConversationId: null,
  messages: [],

  setConversations: (conversations) => set({ conversations }),

  setCurrentConversation: (id) => set({ currentConversationId: id }),

  removeConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      currentConversationId:
        state.currentConversationId === id
          ? null
          : state.currentConversationId,
    })),

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
}));
