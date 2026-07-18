import type { ErrorAction } from "@/lib/errors";
import {
  foldAskMarker,
  foldCheckpointMarker,
  foldCitations,
  foldContentDelta,
  foldContentReset,
  foldInteractionTimelineMarker,
  foldPlanReviewMarker,
  foldReasoningDelta,
  foldTeamMarker,
  foldTeamPreviewMarker,
  foldToolUseEnd,
  foldToolUsePhase,
  foldToolUseStart,
  messageLaneFromMessage,
} from "@/lib/foldMessageLane";
import { notifyError } from "@/lib/toast";
import { discardAllPendingChunks } from "@/services/sse/contentBuffer";
import { discardPendingFrames } from "@/services/sse/execFrameBuffer";
import { stopConversation } from "@/services/stopTurn";
import { execRuntime, useExecutionStore } from "@/stores/execution";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import { useInteractionStore } from "@/stores/interactions";
import type { TimelineMarkerDef } from "@/stores/interactions/registry";
import type {
  Citation,
  ContextBlockWire,
  CostBreakdown,
  ResetReason,
  ToolUseEndPayload,
  ToolUseProgressPayload,
  ToolUseStartPayload,
  UsageBreakdown,
} from "@/types/events";
import { create } from "zustand";
import {
  DRAFT_KEY,
  EMPTY_RUNTIME,
  activeRuntime,
  lastAssistantProjectionId,
} from "./runtime";
import type { TurnPhase } from "./turnPhase";
import { armStopConfirmTimeout, isTerminalPhase } from "./turnPhase";
import type { ConversationRuntime, MemoryUpdate, Message } from "./types";

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
  setMemoryUpdates: (
    updates: MemoryUpdate[],
    conversationId?: string | null,
  ) => void;
  addMemoryUpdate: (
    update: MemoryUpdate,
    conversationId?: string | null,
  ) => void;
  addMessage: (message: Message, conversationId?: string | null) => void;
  appendToLastMessage: (chunk: string, conversationId?: string | null) => void;
  resetStreamingContent: (
    reason: ResetReason,
    conversationId?: string | null,
  ) => void;
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
  setServerMessageIdOnLastMessage: (
    messageId: string,
    conversationId?: string | null,
  ) => void;
  /**
   * Resume = same-turn continuation: flip the paused assistant back to streaming
   * under the server turn id. Returns the bubble id, or null if not found.
   */
  resumePausedAssistant: (
    serverMessageId: string,
    conversationId?: string | null,
  ) => string | null;
  addProcessTool: (
    payload: ToolUseStartPayload,
    conversationId?: string | null,
  ) => void;
  endProcessTool: (
    payload: ToolUseEndPayload,
    conversationId?: string | null,
  ) => void;
  setProcessToolPhase: (
    payload: ToolUseProgressPayload,
    conversationId?: string | null,
  ) => void;
  attachCitationsToLastMessage: (
    citations: Citation[],
    conversationId?: string | null,
  ) => void;
  attachEvidenceLedgerToLastMessage: (
    payload: {
      delta?: import("@/types/events").TurnEvidenceLedgerEntry[];
      entries?: import("@/types/events").TurnEvidenceLedgerEntry[] | null;
      cited_ids?: string[] | null;
    },
    conversationId?: string | null,
  ) => void;
  attachFollowups: (
    followups: string[],
    messageId: string | null | undefined,
    conversationId?: string | null,
  ) => void;
  recordTurnWarning: (warning: string, conversationId?: string | null) => void;
  stampPendingTurnWarning: (conversationId?: string | null) => void;
  attachCostToLastMessage: (
    cost: CostBreakdown,
    conversationId?: string | null,
  ) => void;
  attachTurnMetaToLastMessage: (
    meta: {
      usage?: UsageBreakdown;
      rounds?: number;
      finishReason?: string;
      collab?: import("@/types/events").TurnCollabMetrics;
    },
    conversationId?: string | null,
  ) => void;
  attachErrorToLastMessage: (
    error: {
      code: string;
      message: string;
      context?: {
        upstream_status?: number;
        upstream_body_preview?: string | null;
        retry_attempts?: number;
        empty_diagnosis?: string;
      };
    },
    conversationId?: string | null,
  ) => void;
  stampCheckpointMarker: (
    checkpointId: string,
    conversationId?: string | null,
  ) => void;
  stampAskMarker: (askId: string, conversationId?: string | null) => void;
  stampPlanReviewMarker: (
    checkpointId: string,
    conversationId?: string | null,
  ) => void;
  stampTeamPreviewMarker: (
    checkpointId: string,
    conversationId?: string | null,
  ) => void;
  /** Registry-driven timeline marker stamp (approval / escalation / …). */
  stampTimelineMarker: (
    marker: TimelineMarkerDef,
    id: string,
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
  /** Mark user + paired assistant with local outbox sync hint (desktop-only). */
  setTurnSyncStatus: (
    userMessageId: string,
    syncStatus: Message["syncStatus"],
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
  setTurnPhase: (phase: TurnPhase, conversationId?: string | null) => void;
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

    // 记忆更新对话内可见 (§1.6): replace the tail cards — only the latest-window
    // loads call this (a jump/around window has no tail), so it never clobbers cards
    // while the user is reading mid-history.
    setMemoryUpdates: (updates, conversationId) =>
      patchConversation(conversationId, () => ({ memoryUpdates: updates })),

    // Live firehose append (`memory_updated`): dedup by id, and ONLY when the slice is
    // already loaded — never materialise an empty runtime for a background conversation
    // (it would have a card but no messages); that conversation fetches the card itself
    // on next open. Appended last because consolidation post-dates every message.
    addMemoryUpdate: (update, conversationId) =>
      set((state) => {
        const key = conversationId ?? state.currentConversationId ?? DRAFT_KEY;
        const cur = state.byId[key];
        if (!cur) return {};
        if (cur.memoryUpdates.some((u) => u.id === update.id)) return {};
        return {
          byId: {
            ...state.byId,
            [key]: { ...cur, memoryUpdates: [...cur.memoryUpdates, update] },
          },
        };
      }),

    addMessage: (message, conversationId) =>
      patchConversation(conversationId, (rt) => ({
        messages: [...rt.messages, message],
      })),

    appendToLastMessage: (chunk, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last) return null;
        const lane = foldContentDelta(messageLaneFromMessage(last), chunk);
        messages[messages.length - 1] = {
          ...last,
          content: lane.content,
          process: lane.process,
          composingTool: null,
        };
        return { messages };
      }),

    resetStreamingContent: (reason, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        const lane = foldContentReset(messageLaneFromMessage(last), reason);
        messages[messages.length - 1] = {
          ...last,
          content: lane.content,
          process: lane.process,
        };
        return { messages };
      }),

    appendReasoningToLastMessage: (chunk, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last) return null;
        const lane = foldReasoningDelta(messageLaneFromMessage(last), chunk);
        messages[messages.length - 1] = {
          ...last,
          reasoning: lane.reasoning,
          process: lane.process,
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

    setServerMessageIdOnLastMessage: (messageId, conversationId) => {
      let clientId: string | null = null;
      patchConversation(conversationId, (rt) => {
        if (!messageId) return null;
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        clientId = last.id;
        messages[messages.length - 1] = { ...last, serverMessageId: messageId };
        return { messages };
      });
      // First stamp: align execution.byId client → server so pause/resume share one key.
      if (clientId && clientId !== messageId) {
        useExecutionStore.getState().alignTurnKey(clientId, messageId);
      }
    },

    resumePausedAssistant: (serverMessageId, conversationId) => {
      if (!serverMessageId) return null;
      let foundId: string | null = null;
      patchConversation(conversationId, (rt) => {
        const idx = rt.messages.findIndex(
          (m) =>
            m.role === "assistant" &&
            (m.serverMessageId === serverMessageId || m.id === serverMessageId),
        );
        if (idx < 0) return null;
        const messages = [...rt.messages];
        const prev = messages[idx];
        foundId = prev.id;
        messages[idx] = {
          ...prev,
          isStreaming: true,
          serverMessageId: prev.serverMessageId ?? serverMessageId,
          finishReason: undefined,
          composingTool: null,
        };
        return { messages, isGenerating: true };
      });
      return foundId;
    },

    addProcessTool: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        const lane = foldToolUseStart(messageLaneFromMessage(last), payload);
        if (lane.process === last.process) return null;
        messages[messages.length - 1] = {
          ...last,
          process: lane.process,
          composingTool: null,
        };
        return { messages };
      }),

    endProcessTool: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        const lane = foldToolUseEnd(messageLaneFromMessage(last), payload);
        if (lane.process === last.process) return null;
        messages[messages.length - 1] = { ...last, process: lane.process };
        return { messages };
      }),

    // 工具执行阶段进度 (联网搜索前端展示优化): stamp the running tool step's coarse phase from a
    // (transport-only, live-stream) tool_use_progress event so the waiting UI is honest.
    setProcessToolPhase: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        const lane = foldToolUsePhase(messageLaneFromMessage(last), payload);
        if (lane.process === last.process) return null;
        messages[messages.length - 1] = { ...last, process: lane.process };
        return { messages };
      }),

    attachCitationsToLastMessage: (citations, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (citations.length === 0) return null;
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        const lane = foldCitations(messageLaneFromMessage(last), citations);
        messages[messages.length - 1] = { ...last, citations: lane.citations };
        return { messages };
      }),

    attachEvidenceLedgerToLastMessage: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        let next = last.evidenceLedger ?? [];
        if (Array.isArray(payload.entries)) {
          next = payload.entries;
        } else if (payload.delta?.length) {
          const order: string[] = [];
          const byId = new Map<string, (typeof next)[number]>();
          for (const e of next) {
            if (!byId.has(e.id)) order.push(e.id);
            byId.set(e.id, e);
          }
          for (const e of payload.delta) {
            if (!byId.has(e.id)) order.push(e.id);
            byId.set(e.id, e);
          }
          next = order.map((id) => byId.get(id)!);
        } else {
          return null;
        }
        messages[messages.length - 1] = { ...last, evidenceLedger: next };
        return { messages };
      }),

    attachFollowups: (followups, messageId, conversationId) =>
      patchConversation(conversationId, (rt) => {
        // Identity seam: chips belong to a specific assistant row. Missing message_id
        // is a no-op — never fall back to「last assistant」(fast consecutive turns
        // would otherwise stamp the wrong bubble).
        if (followups.length === 0 || !messageId) return null;
        const messages = [...rt.messages];
        const idx = messages.findIndex(
          (m) =>
            m.role === "assistant" &&
            (m.id === messageId || m.serverMessageId === messageId),
        );
        if (idx < 0) return null;
        messages[idx] = { ...messages[idx], followups };
        return { messages };
      }),

    recordTurnWarning: (warning, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && last.isStreaming) {
          messages[messages.length - 1] = { ...last, turnWarning: warning };
          return { messages, pendingTurnWarning: null };
        }
        return { pendingTurnWarning: warning };
      }),

    stampPendingTurnWarning: (conversationId) =>
      patchConversation(conversationId, (rt) => {
        const warning = rt.pendingTurnWarning;
        if (!warning) return null;
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") {
          return { pendingTurnWarning: warning };
        }
        messages[messages.length - 1] = { ...last, turnWarning: warning };
        return { messages, pendingTurnWarning: null };
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
            ...(meta.collab !== undefined ? { collab: meta.collab } : {}),
          };
        }
        return { messages };
      }),

    stampCheckpointMarker: (checkpointId, conversationId) =>
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
        const lane = foldCheckpointMarker(
          messageLaneFromMessage(msg),
          checkpointId,
        );
        messages[idx] = {
          ...msg,
          content: lane.content,
          process: lane.process,
        };
        return { messages };
      }),

    stampAskMarker: (askId, conversationId) =>
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
        const lane = foldAskMarker(messageLaneFromMessage(msg), askId);
        messages[idx] = { ...msg, process: lane.process };
        return { messages };
      }),

    stampPlanReviewMarker: (checkpointId, conversationId) =>
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
        const lane = foldPlanReviewMarker(
          messageLaneFromMessage(msg),
          checkpointId,
        );
        messages[idx] = { ...msg, process: lane.process };
        return { messages };
      }),

    stampTeamPreviewMarker: (checkpointId, conversationId) =>
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
        const lane = foldTeamPreviewMarker(
          messageLaneFromMessage(msg),
          checkpointId,
        );
        messages[idx] = { ...msg, process: lane.process };
        return { messages };
      }),

    stampTimelineMarker: (marker, id, conversationId) =>
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
        const lane = foldInteractionTimelineMarker(
          messageLaneFromMessage(msg),
          marker,
          id,
        );
        messages[idx] = {
          ...msg,
          content: lane.content,
          process: lane.process,
        };
        return { messages };
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

    setTurnSyncStatus: (userMessageId, syncStatus, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const userIdx = messages.findIndex(
          (m) => m.id === userMessageId && m.role === "user",
        );
        if (userIdx === -1) return null;
        messages[userIdx] = { ...messages[userIdx], syncStatus };
        for (let i = userIdx + 1; i < messages.length; i++) {
          if (messages[i].role === "assistant") {
            messages[i] = { ...messages[i], syncStatus };
            break;
          }
          if (messages[i].role === "user") break;
        }
        return { messages };
      }),

    setLastAssistantExecutionId: (executionId, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            const msg = messages[i];
            // 协作图时间线落点: stamp the executionId AND drop a `team` marker fixing the
            // collaboration graph's slot in the CEO timeline (dedup by execution_id, so a
            // debate's two run_plans / a repeat batch only anchor once).
            const lane = foldTeamMarker(
              messageLaneFromMessage(msg),
              executionId,
            );
            const idChanged = msg.executionId !== executionId;
            const procChanged = lane.process !== msg.process;
            if (!idChanged && !procChanged) return null;
            messages[i] = {
              ...msg,
              ...(idChanged ? { executionId } : {}),
              ...(procChanged ? { process: lane.process } : {}),
            };
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
        memoryUpdates: [],
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
          useInteractionStore.getState().listPending(prevKey).length > 0;
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
          useInteractionStore.getState().listPending(conversationId).length > 0;
        if (busy) return {};
        const byId = { ...state.byId };
        delete byId[conversationId];
        return { byId };
      }),

    setAbort: (a, conversationId) =>
      patchConversation(conversationId, () => ({ abort: a })),

    setTurnPhase: (phase, conversationId) =>
      patchConversation(conversationId, () => ({ turnPhase: phase })),

    stopGeneration: () => {
      const conversationId = get().currentConversationId;
      const key = conversationId ?? DRAFT_KEY;
      const phase = activeRuntime(get()).turnPhase;
      if (phase !== "stopping" && !isTerminalPhase(phase)) {
        get().setTurnPhase("stopping", conversationId);
        armStopConfirmTimeout(key, () => {
          const rt = get().byId[key] ?? EMPTY_RUNTIME;
          if (rt.turnPhase === "stopping") {
            get().setTurnPhase("stopped", conversationId);
          }
        });
      }
      activeRuntime(get()).abort?.abort();
      discardAllPendingChunks(key);
      discardPendingFrames(key);
      if (conversationId) {
        void stopConversation(conversationId).catch(() => {
          notifyError("停止请求失败，引擎可能仍在后台运行");
        });
      }
      patchActive(() => ({ abort: null }));
      get().finalizeLastMessage();
      clearInteractionPrompts(key);
      const mid = lastAssistantProjectionId(activeRuntime(get()).messages);
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
