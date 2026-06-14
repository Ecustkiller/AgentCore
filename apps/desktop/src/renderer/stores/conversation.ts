import { useApprovalStore } from "@/stores/approvals";
import { useExecutionStore } from "@/stores/execution";
import type { Citation, CostBreakdown } from "@/types/events";
import { create } from "zustand";

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  /** Folder membership for the sidebar grouping (§七). Absent/null = ungrouped. */
  folderId?: string | null;
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
  /** Web sources backing an assistant reply; rendered as source cards. */
  citations?: Citation[];
  /** Turn-total cost (回合总账) from `message_end.cost`; drives the per-turn cost
   * row (§7.3A). Absent until the turn ends. Ledger nano-USD shape (no
   * `cny_total` — the client converts via the single FX rate). All-zero `total`
   * renders as「—」, not「¥0.00」(§7.5). */
  cost?: CostBreakdown;
}

/**
 * Per-conversation turn runtime — the live state of one conversation's stream.
 *
 * Keyed by conversation id in {@link ConversationState.byId} so several
 * conversations can have an in-flight (or just-finished) turn at once; the view
 * reads whichever slice is active. A draft chat with no id yet lives under
 * {@link DRAFT_KEY}.
 */
export interface ConversationRuntime {
  messages: Message[];
  isGenerating: boolean;
  /** AbortController for the in-flight turn (send or regenerate), if any. */
  abort: AbortController | null;
  /** User-facing error for the last failed turn, with a one-click retry. */
  error: string | null;
  retry: (() => void) | null;
  /** Cross-component "scroll to + flash" target. Set by surfaces that need to
   * jump the conversation to one message — e.g. the collaboration graph's CEO
   * synthesis node pointing at this turn's final answer. The nonce re-triggers
   * the scroll/flash when the same message is focused again. */
  messageFocus: { id: string; nonce: number } | null;
}

/** Runtime key for a draft chat that has no conversation id yet. */
const DRAFT_KEY = "";

const EMPTY_RUNTIME: ConversationRuntime = {
  messages: [],
  isGenerating: false,
  abort: null,
  error: null,
  retry: null,
  messageFocus: null,
};

/** The active conversation's runtime slice (or an empty one). Single source for
 * every active-slice selector and imperative reader. */
export function activeRuntime(state: ConversationState): ConversationRuntime {
  return state.byId[state.currentConversationId ?? DRAFT_KEY] ?? EMPTY_RUNTIME;
}

interface ConversationState {
  conversations: Conversation[];
  currentConversationId: string | null;
  /** Live turn state per conversation id (draft chat under {@link DRAFT_KEY}). */
  byId: Record<string, ConversationRuntime>;

  setConversations: (conversations: Conversation[]) => void;
  setCurrentConversation: (id: string | null) => void;
  removeConversation: (id: string) => void;
  /** Set a conversation's folder (optimistic move; null = ungrouped). No-op if
   * the id isn't in the list. */
  setConversationFolder: (id: string, folderId: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  appendToLastMessage: (chunk: string) => void;
  appendReasoningToLastMessage: (chunk: string) => void;
  /** Attach aggregated web sources to the last assistant message (live turn). */
  attachCitationsToLastMessage: (citations: Citation[]) => void;
  /** Attach the turn-total cost to the last assistant message (回合总账, from
   * `message_end.cost`); no-op if there is no cost or no assistant to attach to. */
  attachCostToLastMessage: (cost: CostBreakdown) => void;
  createAssistantMessage: () => string;
  finalizeLastMessage: () => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  /** Drop every message after `id` (exclusive). Used by regenerate / edit. */
  truncateAfter: (id: string) => void;
  /** Replace the optimistic id of the last user message with the backend's
   * authoritative id (from `turn_saved`), so regenerate / edit / retry target
   * the real row. */
  reconcileLastTurn: (userMessageId: string) => void;
  /** Stamp the current execution id onto the last assistant message (on
   * `run_plan` for a multi-agent turn). Marks the turn as team-driven so its
   * bubble defers the cost row to the team card (§7.3A, avoids double display).
   * No-op if already set or there is no assistant message. */
  setLastAssistantExecutionId: (executionId: string) => void;
  setGenerating: (v: boolean) => void;
  clearMessages: () => void;
  switchConversation: (id: string | null) => void;
  renameConversation: (id: string, title: string) => void;
  /** Move a conversation to the top of the list and stamp `updatedAt` = now, so
   * a turn (send / regenerate) bumps it into the "今天" group like the backend
   * ordering will on the next reload. No-op if the id isn't in the list. */
  bumpConversation: (id: string) => void;
  /** Undo an optimistic `bumpConversation`: put the conversation back at `index`
   * and restore its `updatedAt`. Used when a send fails before the server
   * persisted it, so the list order reflects reality. No-op if the id is gone. */
  restoreConversation: (id: string, index: number, updatedAt: string) => void;
  /** Register the controller for the current turn (cleared when it ends). */
  setAbort: (a: AbortController | null) => void;
  /** Abort the in-flight turn and finalize the streaming message. */
  stopGeneration: () => void;
  setError: (message: string, retry: (() => void) | null) => void;
  clearError: () => void;
  /** Scroll the conversation to a message and flash it. Bumps a nonce so
   * re-focusing the same id re-triggers the effect; no-op visuals if the id is
   * not currently rendered. */
  focusMessage: (id: string) => void;
}

export const useConversationStore = create<ConversationState>((set, get) => {
  /** Update the active conversation's runtime slice (lazily created). Return
   * null from `update` for a no-op (leaves `byId` untouched). */
  const patchActive = (
    update: (rt: ConversationRuntime) => Partial<ConversationRuntime> | null,
  ): void =>
    set((state) => {
      const key = state.currentConversationId ?? DRAFT_KEY;
      const cur = state.byId[key] ?? EMPTY_RUNTIME;
      const patch = update(cur);
      if (!patch) return {};
      return { byId: { ...state.byId, [key]: { ...cur, ...patch } } };
    });

  return {
    conversations: [],
    currentConversationId: null,
    byId: {},

    setConversations: (conversations) => set({ conversations }),

  setCurrentConversation: (id) => set({ currentConversationId: id }),

  removeConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      currentConversationId:
        state.currentConversationId === id ? null : state.currentConversationId,
    })),

  setConversationFolder: (id, folderId) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, folderId } : c,
      ),
    })),

  setMessages: (messages) => patchActive(() => ({ messages })),

  addMessage: (message) =>
    patchActive((rt) => ({ messages: [...rt.messages, message] })),

  appendToLastMessage: (chunk) =>
    patchActive((rt) => {
      const messages = [...rt.messages];
      const last = messages[messages.length - 1];
      if (!last) return null;
      messages[messages.length - 1] = {
        ...last,
        content: last.content + chunk,
      };
      return { messages };
    }),

  appendReasoningToLastMessage: (chunk) =>
    patchActive((rt) => {
      const messages = [...rt.messages];
      const last = messages[messages.length - 1];
      if (!last) return null;
      messages[messages.length - 1] = {
        ...last,
        reasoning: (last.reasoning ?? "") + chunk,
      };
      return { messages };
    }),

  attachCitationsToLastMessage: (citations) =>
    patchActive((rt) => {
      if (citations.length === 0) return null;
      const messages = [...rt.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, citations };
      }
      return { messages };
    }),

  attachCostToLastMessage: (cost) =>
    patchActive((rt) => {
      const messages = [...rt.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, cost };
      }
      return { messages };
    }),

  createAssistantMessage: () => {
    const id = crypto.randomUUID();
    patchActive((rt) => ({
      messages: [
        ...rt.messages,
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
    patchActive((rt) => {
      const messages = [...rt.messages];
      const last = messages[messages.length - 1];
      if (last) {
        messages[messages.length - 1] = { ...last, isStreaming: false };
      }
      return { messages, isGenerating: false };
    }),

  updateMessage: (id, update) =>
    patchActive((rt) => ({
      messages: rt.messages.map((m) => (m.id === id ? { ...m, ...update } : m)),
    })),

  truncateAfter: (id) =>
    patchActive((rt) => {
      const idx = rt.messages.findIndex((m) => m.id === id);
      if (idx === -1) return null;
      return { messages: rt.messages.slice(0, idx + 1) };
    }),

  reconcileLastTurn: (userMessageId) =>
    patchActive((rt) => {
      const messages = [...rt.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          messages[i] = { ...messages[i], id: userMessageId };
          break;
        }
      }
      return { messages };
    }),

  setLastAssistantExecutionId: (executionId) =>
    patchActive((rt) => {
      const messages = [...rt.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          if (messages[i].executionId === executionId) return null;
          messages[i] = { ...messages[i], executionId };
          return { messages };
        }
      }
      return null;
    }),

  setGenerating: (v) => patchActive(() => ({ isGenerating: v })),

  clearMessages: () =>
    patchActive(() => ({ messages: [], isGenerating: false, messageFocus: null })),

  switchConversation: (id) => {
    // Leaving the conversation abandons its in-flight turn; drop any pending
    // approval prompt so it can't leak onto the next conversation. (Behaviour is
    // unchanged in this step — concurrent background turns land later.)
    const prevKey = get().currentConversationId ?? DRAFT_KEY;
    get().byId[prevKey]?.abort?.abort();
    useApprovalStore.getState().clear();
    set((state) => {
      const nextKey = id ?? DRAFT_KEY;
      const byId = { ...state.byId };
      delete byId[prevKey];
      byId[nextKey] = { ...EMPTY_RUNTIME };
      return { currentConversationId: id, byId };
    });
  },

  renameConversation: (id, title) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c,
      ),
    })),

  bumpConversation: (id) =>
    set((state) => {
      const target = state.conversations.find((c) => c.id === id);
      if (!target) return {};
      const bumped = { ...target, updatedAt: new Date().toISOString() };
      return {
        conversations: [
          bumped,
          ...state.conversations.filter((c) => c.id !== id),
        ],
      };
    }),

  restoreConversation: (id, index, updatedAt) =>
    set((state) => {
      const target = state.conversations.find((c) => c.id === id);
      if (!target) return {};
      const without = state.conversations.filter((c) => c.id !== id);
      const at = Math.max(0, Math.min(index, without.length));
      const restored = { ...target, updatedAt };
      return {
        conversations: [
          ...without.slice(0, at),
          restored,
          ...without.slice(at),
        ],
      };
    }),

  setAbort: (a) => patchActive(() => ({ abort: a })),

  stopGeneration: () => {
    activeRuntime(get()).abort?.abort();
    patchActive(() => ({ abort: null }));
    get().finalizeLastMessage();
    // Aborting cuts the stream before any `approval_resolved`, so a paused tool
    // call would otherwise leave its prompt stranded — clear it.
    useApprovalStore.getState().clear();
    // The abort skips message_end, so a multi-agent execution would otherwise
    // stay "running" forever — mark it cancelled so the task card leaves its
    // live state and offers a re-run.
    const exec = useExecutionStore.getState();
    if (exec.plan && exec.status === "running") exec.setStatus("cancelled");
  },

  setError: (message, retry) => patchActive(() => ({ error: message, retry })),

  clearError: () => patchActive(() => ({ error: null, retry: null })),

  focusMessage: (id) =>
    patchActive((rt) => ({
      messageFocus: { id, nonce: (rt.messageFocus?.nonce ?? 0) + 1 },
    })),
  };
});
