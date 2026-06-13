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

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];

  setCurrentConversation: (id: string | null) => void;
  addMessage: (message: Message) => void;
  appendToLastMessage: (chunk: string) => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],

  setCurrentConversation: (id) => set({ currentConversationId: id }),

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
