import { describeStreamError, streamErrorAction } from "@/lib/errors";
import { continueConversation } from "@/services/streamConversation";
import {
  type Message,
  getRuntime,
  useConversationStore,
} from "@/stores/conversation";
import type { TurnPhase } from "@/stores/conversation/turnPhase";
import { beginTurnPreflight } from "@/stores/conversation/turnPhaseActions";
import { type ExecutionStatus, useExecutionStore } from "@/stores/execution";
import { finalizeHonestStopAbort, isAbort, isTransportDrop } from "./helpers";
import { rejoinLiveTurn } from "./recovery";

function resolveContinueMessageId(
  conversationId: string,
  messageId: string,
): string {
  const assistant = getRuntime(conversationId).messages.find(
    (m) =>
      m.role === "assistant" &&
      (m.id === messageId || m.serverMessageId === messageId),
  );
  return assistant?.serverMessageId ?? messageId;
}

type PausedSurfaceSnapshot = {
  bubbleId: string | null;
  finishReason: string | undefined;
  outcome: Message["outcome"];
  runsFinishReason: string | undefined;
  turnPhase: TurnPhase;
  execStatus: ExecutionStatus | null;
};

function snapshotPausedSurface(
  conversationId: string,
  messageId: string,
): PausedSurfaceSnapshot {
  const rt = getRuntime(conversationId);
  const assistant = rt.messages.find(
    (m) =>
      m.role === "assistant" &&
      (m.id === messageId || m.serverMessageId === messageId),
  );
  return {
    bubbleId: assistant?.id ?? null,
    finishReason: assistant?.finishReason ?? "paused",
    outcome: assistant?.outcome ?? "paused",
    runsFinishReason: assistant?.runs?.finishReason,
    turnPhase: rt.turnPhase,
    execStatus: useExecutionStore.getState().byId[messageId]?.status ?? null,
  };
}

/** Put the attested pause face back after continue failed to take over the stream. */
function restorePausedSurface(
  conversationId: string,
  messageId: string,
  snap: PausedSurfaceSnapshot,
): void {
  const store = useConversationStore.getState();
  if (snap.bubbleId) {
    const current = getRuntime(conversationId).messages.find(
      (m) => m.id === snap.bubbleId,
    );
    if (current) {
      store.updateMessage(
        snap.bubbleId,
        {
          isStreaming: false,
          finishReason: snap.finishReason,
          outcome: snap.outcome,
          runs: current.runs
            ? {
                ...current.runs,
                finishReason:
                  snap.runsFinishReason ?? current.runs.finishReason,
              }
            : current.runs,
        },
        conversationId,
      );
    }
  }
  if (getRuntime(conversationId).isGenerating) {
    store.finalizeLastMessage(conversationId);
  }
  store.setTurnPhase(snap.turnPhase, conversationId);
  if (snap.execStatus && useExecutionStore.getState().byId[messageId]) {
    useExecutionStore.getState().setStatus(snap.execStatus, messageId);
  }
}

/**
 * Same-turn continue for attested `outcome=paused` (CEO rate-limit).
 * Calls POST …/messages/{id}/continue — not checkpoint resume.
 */
export async function continuePausedTurn(opts: {
  conversationId: string;
  messageId: string;
}): Promise<void> {
  const { conversationId } = opts;
  const store = useConversationStore.getState();
  if (getRuntime(conversationId).isGenerating) {
    store.setError(
      "当前回合仍在生成中，请稍后再点继续",
      null,
      conversationId,
      null,
    );
    return;
  }

  const messageId = resolveContinueMessageId(conversationId, opts.messageId);
  const pausedSnap = snapshotPausedSurface(conversationId, messageId);
  store.clearError(conversationId);
  store.resumePausedAssistant(messageId, conversationId);
  if (useExecutionStore.getState().byId[messageId]) {
    useExecutionStore.getState().setStatus("running", messageId);
  }

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  beginTurnPreflight(conversationId);
  try {
    await continueConversation({
      conversationId,
      messageId,
      signal: ac.signal,
    });
  } catch (err) {
    if (isAbort(err)) {
      finalizeHonestStopAbort(conversationId);
      restorePausedSurface(conversationId, messageId, pausedSnap);
      return;
    }
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) {
      return;
    }
    if (getRuntime(conversationId).isGenerating) {
      store.finalizeLastMessage(conversationId);
    }
    restorePausedSurface(conversationId, messageId, pausedSnap);
    const msg = describeStreamError(err);
    if (msg) {
      store.setError(msg, null, conversationId, streamErrorAction(err));
    }
  } finally {
    if (getRuntime(conversationId).abort === ac) {
      useConversationStore.getState().setAbort(null, conversationId);
    }
  }
}
