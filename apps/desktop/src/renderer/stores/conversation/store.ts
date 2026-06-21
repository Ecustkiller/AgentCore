import type { ErrorAction } from "@/lib/errors";
import {
  appendContentStep,
  appendReasoningStep,
  appendToolStep,
  dropTrailingContentSteps,
  resolveToolStep,
} from "@/lib/processTimeline";
import { stopConversation } from "@/services/stopTurn";
import { useApprovalStore } from "@/stores/approvals";
import { execRuntime, useExecutionStore } from "@/stores/execution";
import type {
  CheckpointDecision,
  CheckpointRequiredPayload,
  Citation,
  ContextBlockWire,
  CostBreakdown,
  PlanReviewRequiredPayload,
  QuestionPostedPayload,
  ToolUseEndPayload,
  ToolUseStartPayload,
  UsageBreakdown,
} from "@/types/events";
import { create } from "zustand";
import {
  DRAFT_KEY,
  EMPTY_RUNTIME,
  activeRuntime,
  lastAssistantMessageId,
  runtimeOf,
} from "./runtime";
import type { ConversationRuntime, Message } from "./types";

export interface ConversationState {
  currentConversationId: string | null;
  byId: Record<string, ConversationRuntime>;
  pendingFocus: { conversationId: string; messageId: string } | null;

  setCurrentConversation: (id: string | null) => void;
  dropConversationRuntime: (id: string) => void;
  setMessages: (messages: Message[]) => void;
  setMessageWindow: (
    messages: Message[],
    flags: { hasMoreBefore: boolean; hasMoreAfter: boolean },
    conversationId?: string | null,
  ) => void;
  prependMessages: (
    older: Message[],
    hasMoreBefore: boolean,
    conversationId?: string | null,
  ) => void;
  appendNewerMessages: (
    newer: Message[],
    hasMoreAfter: boolean,
    conversationId?: string | null,
  ) => void;
  setLoadingOlder: (v: boolean, conversationId?: string | null) => void;
  setLoadingNewer: (v: boolean, conversationId?: string | null) => void;
  addMessage: (message: Message, conversationId?: string | null) => void;
  appendToLastMessage: (chunk: string, conversationId?: string | null) => void;
  resetStreamingContent: (conversationId?: string | null) => void;
  appendReasoningToLastMessage: (
    chunk: string,
    conversationId?: string | null,
  ) => void;
  setComposingTool: (
    tool: { toolName: string; chars: number } | null,
    conversationId?: string | null,
  ) => void;
  setTraceIdOnLastMessage: (
    traceId: string,
    conversationId?: string | null,
  ) => void;
  addProcessTool: (
    payload: ToolUseStartPayload,
    conversationId?: string | null,
  ) => void;
  endProcessTool: (
    payload: ToolUseEndPayload,
    conversationId?: string | null,
  ) => void;
  attachCitationsToLastMessage: (
    citations: Citation[],
    conversationId?: string | null,
  ) => void;
  attachCostToLastMessage: (
    cost: CostBreakdown,
    conversationId?: string | null,
  ) => void;
  attachTurnMetaToLastMessage: (
    meta: {
      usage?: UsageBreakdown;
      rounds?: number;
      finishReason?: string;
    },
    conversationId?: string | null,
  ) => void;
  attachErrorToLastMessage: (
    error: { code: string; message: string },
    conversationId?: string | null,
  ) => void;
  addCheckpoint: (
    payload: CheckpointRequiredPayload,
    conversationId?: string | null,
  ) => void;
  settleCheckpoint: (
    checkpointId: string,
    decision: CheckpointDecision,
    note: string,
    selected: string[],
    conversationId?: string | null,
  ) => void;
  addNonBlockingAsk: (
    payload: QuestionPostedPayload,
    conversationId?: string | null,
  ) => void;
  addPlanReview: (
    payload: PlanReviewRequiredPayload,
    conversationId?: string | null,
  ) => void;
  settlePlanReview: (
    checkpointId: string,
    decision: CheckpointDecision,
    note: string,
    conversationId?: string | null,
  ) => void;
  createAssistantMessage: (conversationId?: string | null) => string;
  finalizeLastMessage: (conversationId?: string | null) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  removeMessage: (id: string, conversationId?: string | null) => void;
  truncateAfter: (id: string, conversationId?: string | null) => void;
  reconcileLastTurn: (
    userMessageId: string,
    conversationId?: string | null,
  ) => void;
  setLastAssistantExecutionId: (
    executionId: string,
    conversationId?: string | null,
  ) => void;
  setCaptainContext: (
    blocks: ContextBlockWire[],
    conversationId?: string | null,
  ) => void;
  setGenerating: (v: boolean, conversationId?: string | null) => void;
  clearMessages: () => void;
  switchConversation: (id: string | null) => void;
  releaseBackgroundSlice: (conversationId: string) => void;
  setAbort: (a: AbortController | null, conversationId?: string | null) => void;
  stopGeneration: () => void;
  setError: (
    message: string,
    retry: (() => void) | null,
    conversationId?: string | null,
    action?: ErrorAction | null,
  ) => void;
  clearError: (conversationId?: string | null) => void;
  focusMessage: (id: string) => void;
  requestMessageFocus: (conversationId: string, messageId: string) => void;
  clearPendingFocus: () => void;
}

export const useConversationStore = create<ConversationState>((set, get) => {
  const patchConversation = (
    conversationId: string | null | undefined,
    update: (rt: ConversationRuntime) => Partial<ConversationRuntime> | null,
  ): void =>
    set((state) => {
      const key = conversationId ?? state.currentConversationId ?? DRAFT_KEY;
      const cur = state.byId[key] ?? EMPTY_RUNTIME;
      const patch = update(cur);
      if (!patch) return {};
      return { byId: { ...state.byId, [key]: { ...cur, ...patch } } };
    });

  const patchActive = (
    update: (rt: ConversationRuntime) => Partial<ConversationRuntime> | null,
  ): void => patchConversation(undefined, update);

  return {
    currentConversationId: null,
    byId: {},
    pendingFocus: null,

    setCurrentConversation: (id) => set({ currentConversationId: id }),

    dropConversationRuntime: (id) =>
      set((state) => {
        const byId = { ...state.byId };
        delete byId[id];
        return {
          currentConversationId:
            state.currentConversationId === id
              ? null
              : state.currentConversationId,
          byId,
        };
      }),

    setMessages: (messages) => patchActive(() => ({ messages })),

    setMessageWindow: (messages, flags, conversationId) =>
      patchConversation(conversationId, () => ({
        messages,
        hasMoreBefore: flags.hasMoreBefore,
        hasMoreAfter: flags.hasMoreAfter,
      })),

    prependMessages: (older, hasMoreBefore, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (older.length === 0) return { hasMoreBefore };
        const known = new Set(rt.messages.map((m) => m.id));
        const fresh = older.filter((m) => !known.has(m.id));
        return { messages: [...fresh, ...rt.messages], hasMoreBefore };
      }),

    appendNewerMessages: (newer, hasMoreAfter, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (newer.length === 0) return { hasMoreAfter };
        const known = new Set(rt.messages.map((m) => m.id));
        const fresh = newer.filter((m) => !known.has(m.id));
        return { messages: [...rt.messages, ...fresh], hasMoreAfter };
      }),

    setLoadingOlder: (v, conversationId) =>
      patchConversation(conversationId, () => ({ loadingOlder: v })),

    setLoadingNewer: (v, conversationId) =>
      patchConversation(conversationId, () => ({ loadingNewer: v })),

    addMessage: (message, conversationId) =>
      patchConversation(conversationId, (rt) => ({
        messages: [...rt.messages, message],
      })),

    appendToLastMessage: (chunk, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last) return null;
        messages[messages.length - 1] = {
          ...last,
          content: last.content + chunk,
          process: appendContentStep(last.process, chunk),
          composingTool: null,
        };
        return { messages };
      }),

    resetStreamingContent: (conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        messages[messages.length - 1] = {
          ...last,
          content: "",
          process: dropTrailingContentSteps(last.process),
        };
        return { messages };
      }),

    appendReasoningToLastMessage: (chunk, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last) return null;
        messages[messages.length - 1] = {
          ...last,
          reasoning: (last.reasoning ?? "") + chunk,
          process: appendReasoningStep(last.process, chunk),
        };
        return { messages };
      }),

    setComposingTool: (tool, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        messages[messages.length - 1] = { ...last, composingTool: tool };
        return { messages };
      }),

    setTraceIdOnLastMessage: (traceId, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (!traceId) return null;
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        messages[messages.length - 1] = { ...last, traceId };
        return { messages };
      }),

    addProcessTool: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        messages[messages.length - 1] = {
          ...last,
          process: appendToolStep(last.process, payload),
          composingTool: null,
        };
        return { messages };
      }),

    endProcessTool: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        const process = resolveToolStep(last.process, payload);
        if (process === last.process) return null;
        messages[messages.length - 1] = { ...last, process };
        return { messages };
      }),

    attachCitationsToLastMessage: (citations, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (citations.length === 0) return null;
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          messages[messages.length - 1] = { ...last, citations };
        }
        return { messages };
      }),

    attachErrorToLastMessage: (error, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          messages[messages.length - 1] = { ...last, error };
        }
        return { messages };
      }),

    attachCostToLastMessage: (cost, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          messages[messages.length - 1] = { ...last, cost };
        }
        return { messages };
      }),

    attachTurnMetaToLastMessage: (meta, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          messages[messages.length - 1] = {
            ...last,
            ...(meta.usage !== undefined ? { usage: meta.usage } : {}),
            ...(meta.rounds !== undefined ? { rounds: meta.rounds } : {}),
            ...(meta.finishReason !== undefined
              ? { finishReason: meta.finishReason }
              : {}),
          };
        }
        return { messages };
      }),

    addCheckpoint: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            idx = i;
            break;
          }
        }
        if (idx === -1) return null;
        const msg = messages[idx];
        const existing = msg.checkpoints ?? [];
        if (existing.some((c) => c.id === payload.checkpoint_id)) return null;
        messages[idx] = {
          ...msg,
          checkpoints: [
            ...existing,
            {
              id: payload.checkpoint_id,
              question: payload.question,
              context: payload.context ?? "",
              assumptions: payload.assumptions ?? [],
              questions: payload.questions ?? [],
              styleOptions: payload.style_options ?? [],
              status: "pending",
              decision: null,
              note: "",
              selected: [],
            },
          ],
        };
        return { messages };
      }),

    addNonBlockingAsk: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            idx = i;
            break;
          }
        }
        if (idx === -1) return null;
        const msg = messages[idx];
        const existing = msg.nonBlockingAsks ?? [];
        if (existing.some((a) => a.id === payload.ask_id)) return null;
        messages[idx] = {
          ...msg,
          nonBlockingAsks: [
            ...existing,
            {
              id: payload.ask_id,
              question: payload.question,
              context: payload.context ?? "",
              assumptions: payload.assumptions ?? [],
              questions: payload.questions ?? [],
              styleOptions: payload.style_options ?? [],
            },
          ],
        };
        return { messages };
      }),

    settleCheckpoint: (
      checkpointId,
      decision,
      note,
      selected,
      conversationId,
    ) =>
      patchConversation(conversationId, (rt) => {
        let changed = false;
        const messages = rt.messages.map((m) => {
          if (!m.checkpoints?.some((c) => c.id === checkpointId)) return m;
          changed = true;
          return {
            ...m,
            checkpoints: m.checkpoints.map((c) =>
              c.id === checkpointId
                ? {
                    ...c,
                    status: "resolved" as const,
                    decision,
                    note,
                    selected,
                  }
                : c,
            ),
          };
        });
        return changed ? { messages } : null;
      }),

    addPlanReview: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            idx = i;
            break;
          }
        }
        if (idx === -1) return null;
        const msg = messages[idx];
        const existing = msg.planReviews ?? [];
        if (existing.some((c) => c.id === payload.checkpoint_id)) return null;
        messages[idx] = {
          ...msg,
          planReviews: [
            ...existing,
            {
              id: payload.checkpoint_id,
              steps: payload.steps ?? [],
              pending: payload.pending ?? [],
              status: "pending",
              decision: null,
              note: "",
            },
          ],
        };
        return { messages };
      }),

    settlePlanReview: (checkpointId, decision, note, conversationId) =>
      patchConversation(conversationId, (rt) => {
        let changed = false;
        const messages = rt.messages.map((m) => {
          if (!m.planReviews?.some((c) => c.id === checkpointId)) return m;
          changed = true;
          return {
            ...m,
            planReviews: m.planReviews.map((c) =>
              c.id === checkpointId
                ? { ...c, status: "resolved" as const, decision, note }
                : c,
            ),
          };
        });
        return changed ? { messages } : null;
      }),

    createAssistantMessage: (conversationId) => {
      const id = crypto.randomUUID();
      patchConversation(conversationId, (rt) => ({
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

    finalizeLastMessage: (conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last) {
          messages[messages.length - 1] = {
            ...last,
            isStreaming: false,
            composingTool: null,
          };
        }
        return { messages, isGenerating: false };
      }),

    updateMessage: (id, update) =>
      patchActive((rt) => ({
        messages: rt.messages.map((m) =>
          m.id === id ? { ...m, ...update } : m,
        ),
      })),

    removeMessage: (id, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (!rt.messages.some((m) => m.id === id)) return null;
        return { messages: rt.messages.filter((m) => m.id !== id) };
      }),

    truncateAfter: (id, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const idx = rt.messages.findIndex((m) => m.id === id);
        if (idx === -1) return null;
        return {
          messages: rt.messages.slice(0, idx + 1),
          hasMoreAfter: false,
        };
      }),

    reconcileLastTurn: (userMessageId, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            messages[i] = { ...messages[i], id: userMessageId };
            break;
          }
        }
        return { messages };
      }),

    setLastAssistantExecutionId: (executionId, conversationId) =>
      patchConversation(conversationId, (rt) => {
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

    setCaptainContext: (blocks, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            messages[i] = { ...messages[i], captainContext: blocks };
            return { messages };
          }
        }
        return null;
      }),

    setGenerating: (v, conversationId) =>
      patchConversation(conversationId, () => ({ isGenerating: v })),

    clearMessages: () =>
      patchActive(() => ({
        messages: [],
        isGenerating: false,
        messageFocus: null,
        hasMoreBefore: false,
        hasMoreAfter: false,
      })),

    switchConversation: (id) => {
      const prevKey = get().currentConversationId ?? DRAFT_KEY;
      const nextKey = id ?? DRAFT_KEY;
      if (prevKey === nextKey) {
        set({ currentConversationId: id });
        return;
      }
      set((state) => {
        const byId = { ...state.byId };
        const prev = byId[prevKey];
        const prevBusy =
          !!prev?.isGenerating ||
          useApprovalStore
            .getState()
            .pending.some((p) => p.conversationId === prevKey);
        if (!prevBusy) delete byId[prevKey];
        if (!byId[nextKey]) byId[nextKey] = { ...EMPTY_RUNTIME };
        return { currentConversationId: id, byId };
      });
    },

    releaseBackgroundSlice: (conversationId) =>
      set((state) => {
        const activeKey = state.currentConversationId ?? DRAFT_KEY;
        if (conversationId === activeKey) return {};
        const slice = state.byId[conversationId];
        if (!slice) return {};
        const busy =
          slice.isGenerating ||
          useApprovalStore
            .getState()
            .pending.some((p) => p.conversationId === conversationId);
        if (busy) return {};
        const byId = { ...state.byId };
        delete byId[conversationId];
        return { byId };
      }),

    setAbort: (a, conversationId) =>
      patchConversation(conversationId, () => ({ abort: a })),

    stopGeneration: () => {
      const conversationId = get().currentConversationId;
      activeRuntime(get()).abort?.abort();
      if (conversationId) void stopConversation(conversationId);
      patchActive(() => ({ abort: null }));
      get().finalizeLastMessage();
      useApprovalStore
        .getState()
        .clear(get().currentConversationId ?? DRAFT_KEY);
      const mid = lastAssistantMessageId(activeRuntime(get()).messages);
      if (mid) {
        const exec = useExecutionStore.getState();
        const rt = execRuntime(exec, mid);
        if (rt.plan && rt.status === "running")
          exec.setStatus("cancelled", mid);
      }
    },

    setError: (message, retry, conversationId, action) =>
      patchConversation(conversationId, () => ({
        error: message,
        retry,
        errorAction: action ?? null,
      })),

    clearError: (conversationId) =>
      patchConversation(conversationId, () => ({
        error: null,
        retry: null,
        errorAction: null,
      })),

    focusMessage: (id) =>
      patchActive((rt) => ({
        messageFocus: { id, nonce: (rt.messageFocus?.nonce ?? 0) + 1 },
      })),

    requestMessageFocus: (conversationId, messageId) =>
      set({ pendingFocus: { conversationId, messageId } }),

    clearPendingFocus: () => set({ pendingFocus: null }),
  };
});
