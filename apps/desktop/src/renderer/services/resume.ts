import { api } from "@/services/api";
import { resolveSidecarRoot } from "@/services/sidecarRouting";
import { getRuntime } from "@/stores/conversation";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import {
  entryToCheckpoint,
  entryToPlanReview,
  entryToTeamPreview,
  useInteractionStore,
} from "@/stores/interactions";
import { type ResumeOrigin, usePausedTurnStore } from "@/stores/pausedTurns";
import type { components } from "@/types/api.generated";

type PausedTurnSummary = components["schemas"]["PausedTurnSummary"];
type TurnRecoveryResponse = components["schemas"]["TurnRecoveryResponse"];
type PendingInteractionSummary =
  components["schemas"]["PendingInteractionSummary"];

/** A conversation's recovery snapshot on reopen — see {@link loadRecovery}. */
export interface ConversationRecovery {
  liveRunning: boolean;
  pausedCount: number;
}

function hydratePendingInteractions(
  conversationId: string,
  items: PendingInteractionSummary[],
): void {
  useInteractionStore.getState().hydratePending(
    conversationId,
    items.map((i) => ({
      kind: i.kind,
      id: i.id,
      messageId: i.message_id,
      payload: i.payload ?? {},
    })),
  );
}

function asPendingInteractions(
  res: TurnRecoveryResponse,
): PendingInteractionSummary[] {
  const items = res.pending_interactions ?? [];
  return items.filter(
    (i): i is PendingInteractionSummary =>
      !!i &&
      typeof i.id === "string" &&
      typeof i.kind === "string" &&
      typeof i.message_id === "string",
  );
}

/**
 * Load a conversation's recovery state into the store on reopen (best-effort).
 */
export async function loadRecovery(
  conversationId: string,
): Promise<ConversationRecovery> {
  try {
    const sidecarTarget = await resolveSidecarRoot(conversationId);
    if (sidecarTarget) {
      const paused = (await window.sidecarApi.listPaused({
        rootId: sidecarTarget.rootId,
        conversationId,
      })) as unknown as PausedTurnSummary[];
      usePausedTurnStore
        .getState()
        .setForConversation(conversationId, paused, "sidecar");
      // Local sidecar: no reattachable hot registry — flip hot cards to 已失效.
      clearInteractionPrompts(conversationId);
      return { liveRunning: false, pausedCount: paused.length };
    }
    const res = await api.get<TurnRecoveryResponse>(
      `/v1/conversations/${conversationId}/recovery`,
    );
    const paused = (res.paused ?? []) as PausedTurnSummary[];
    usePausedTurnStore
      .getState()
      .setForConversation(conversationId, paused, "server");
    hydratePendingInteractions(conversationId, asPendingInteractions(res));
    return {
      liveRunning: Boolean(res.live_running),
      pausedCount: paused.length,
    };
  } catch {
    return { liveRunning: false, pausedCount: 0 };
  }
}

export function isClientOnlyResumeKey(
  conversationId: string,
  messageId: string,
): boolean {
  const assistant = getRuntime(conversationId).messages.find(
    (m) => m.role === "assistant" && m.id === messageId,
  );
  return assistant !== undefined && !assistant.serverMessageId;
}

export function surfaceResumeFromLiveTurn(
  conversationId: string,
  origin: ResumeOrigin,
): void {
  const messages = getRuntime(conversationId).messages;
  const turn = [...messages].reverse().find((m) => m.role === "assistant");
  if (!turn) return;
  const serverMessageId = turn.serverMessageId;
  if (!serverMessageId) return;
  const base = {
    messageId: serverMessageId,
    conversationId,
    userMessage:
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "",
    userMessageId:
      [...messages].reverse().find((m) => m.role === "user")?.id ?? "",
    origin,
  };

  const ix = useInteractionStore.getState();
  const pending = ix
    .listPending(conversationId, ["ask_user", "plan_review", "team_preview"])
    .filter(
      (e) =>
        !e.messageId ||
        e.messageId === turn.id ||
        e.messageId === serverMessageId,
    );

  const ask = pending.find((e) => e.kind === "ask_user");
  if (ask) {
    const cp = entryToCheckpoint(ask);
    usePausedTurnStore.getState().addLiveResume({
      ...base,
      checkpointId: cp.id,
      kind: "ask_user",
      steps: [],
      pending: [],
      workers: [],
      question: cp.question,
      context: cp.context,
      assumptions: cp.assumptions,
      questions: cp.questions,
      styleOptions: cp.styleOptions,
      intent: cp.intent,
    });
    return;
  }
  const prEntry = pending.find((e) => e.kind === "plan_review");
  if (prEntry) {
    const pr = entryToPlanReview(prEntry);
    usePausedTurnStore.getState().addLiveResume({
      ...base,
      checkpointId: pr.id,
      kind: "plan_review",
      steps: pr.steps,
      pending: pr.pending,
      workers: [],
      question: "",
      context: "",
      assumptions: [],
      questions: [],
      styleOptions: [],
      intent: "decision",
    });
    return;
  }
  const tpEntry = pending.find((e) => e.kind === "team_preview");
  if (tpEntry) {
    const tp = entryToTeamPreview(tpEntry);
    usePausedTurnStore.getState().addLiveResume({
      ...base,
      checkpointId: tp.id,
      kind: "team_preview",
      steps: [],
      pending: [],
      workers: tp.workers,
      question: "",
      context: "",
      assumptions: [],
      questions: [],
      styleOptions: [],
      intent: "decision",
    });
  }
}
