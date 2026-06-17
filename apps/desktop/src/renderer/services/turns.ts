import {
  bumpConversationCache,
  getConversations,
  restoreConversationCache,
} from "@/hooks/useConversations";
import {
  describeStreamError,
  isRetriableStreamError,
  streamErrorAction,
} from "@/lib/errors";
import { pendingLocalContainerRoot } from "@/services/defaultWorkspace";
import type { PlanReviewUserDecision } from "@/services/planReview";
import {
  buildSidecarHistory,
  resolveSidecarRoot,
} from "@/services/sidecarRouting";
import {
  type OutgoingAttachment,
  regenerateConversation,
  resumeConversation,
  streamConversation,
} from "@/services/streamConversation";
import {
  resumeConversationViaSidecar,
  streamConversationViaSidecar,
} from "@/services/streamConversationViaSidecar";
import { useApprovalStore } from "@/stores/approvals";
import {
  type Message,
  getActiveRuntime,
  getRuntime,
  useConversationStore,
} from "@/stores/conversation";
import { usePausedTurnStore } from "@/stores/pausedTurns";

/** The user's explicit stop (abort button) — never surfaced as an error. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** The most recent user message in the open conversation, or null. Backs the
 * task card's retry / adjust-instruction / replan actions. */
export function lastUserMessage(): Message | null {
  const msgs = getActiveRuntime().messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i];
  }
  return null;
}

/** Id of {@link lastUserMessage}, or null. */
export function lastUserMessageId(): string | null {
  return lastUserMessage()?.id ?? null;
}

/**
 * Re-run a turn from an existing (persisted) user message.
 *
 * Backs the message-level regenerate / edit-and-resend actions, and the retry
 * path once a send has been persisted. Drops everything after the user message,
 * opens a fresh assistant bubble, then streams the new reply; the backend
 * truncates the same range so persisted history stays consistent. On a transport
 * failure it raises a retry banner that re-runs the same regenerate.
 */
export async function runRegenerate(
  userMessageId: string,
  content?: string,
): Promise<void> {
  const store = useConversationStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId || getRuntime(conversationId).isGenerating) return;

  // Route every turn write to this conversation's slice by id, not the active
  // key — the user may switch away mid-stream and the turn keeps running in the
  // background (switchConversation no longer aborts it).
  store.clearError(conversationId);
  bumpConversationCache(conversationId);
  store.truncateAfter(userMessageId, conversationId);
  store.createAssistantMessage(conversationId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    await regenerateConversation({
      conversationId,
      messageId: userMessageId,
      content,
      signal: ac.signal,
    });
  } catch (err) {
    if (isAbort(err)) return;
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    // A failed turn never delivers `approval_resolved`; drop this conversation's
    // paused prompt (other conversations keep theirs).
    useApprovalStore.getState().clear(conversationId);
    const msg = describeStreamError(err);
    if (msg) {
      const retry = isRetriableStreamError(err)
        ? () => void runRegenerate(userMessageId, content)
        : null;
      s.setError(msg, retry, conversationId, streamErrorAction(err));
    }
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}

/**
 * Continue a durably-paused turn (结构化挂起 2b resume) and stream the continuation.
 *
 * The turn paused at a plan_review / ask_user checkpoint and was persisted, then
 * lost its live stream (disconnect / restart). The user's decision (continue /
 * adjust / stop) — plus any ask_user option `selected` — is POSTed to the resume
 * endpoint, which claims the frame and drives the rest of the turn on a fresh SSE.
 * No new user message — the paused turn's user bubble is already persisted; we just
 * open a fresh assistant bubble for the reply (so this turn's run/tool frames have a
 * message to attach to) and stream into it. The resume card is dropped optimistically
 * (the server claim is atomic, so a stale / second attempt simply 404s); a transport
 * failure raises the usual retry banner.
 */
export async function runResume(
  messageId: string,
  decision: PlanReviewUserDecision,
  note: string,
  selected: string[] = [],
): Promise<void> {
  const store = useConversationStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId || getRuntime(conversationId).isGenerating) return;

  store.clearError(conversationId);
  bumpConversationCache(conversationId);

  // Route durable resume the same way as a send: a conversation bound to a present
  // local root resumes on the sidecar engine (双模式工作区 §一.1); else the cloud.
  // Capture the pending frame BEFORE removing it — the sidecar path needs its
  // original user message (never cloud-persisted for a paused sidecar turn).
  const sidecarTarget = await resolveSidecarRoot(conversationId);
  const pending = usePausedTurnStore
    .getState()
    .pending.find((p) => p.messageId === messageId);
  usePausedTurnStore.getState().remove(messageId);

  // A paused sidecar turn's user message was never written to the cloud (it paused
  // before write-back), so it is absent from the reopened transcript. Inject it back
  // (with a fresh id the completion write-back will pin) so the continuation reads
  // naturally and reconciles cleanly. Cloud resume already has its user row loaded.
  const sidecarResume = sidecarTarget !== null && pending !== undefined;
  const userMessageId = sidecarResume ? crypto.randomUUID() : "";
  if (sidecarResume && pending) {
    store.addMessage(
      {
        id: userMessageId,
        role: "user",
        content: pending.userMessage,
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      conversationId,
    );
  }

  store.createAssistantMessage(conversationId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    if (sidecarResume && pending && sidecarTarget) {
      await resumeConversationViaSidecar({
        conversationId,
        rootId: sidecarTarget.rootId,
        subpath: sidecarTarget.subpath,
        messageId,
        decision,
        note,
        selected,
        userMessage: pending.userMessage,
        userMessageId,
        signal: ac.signal,
      });
    } else {
      await resumeConversation({
        conversationId,
        messageId,
        decision,
        note,
        selected,
        signal: ac.signal,
      });
    }
  } catch (err) {
    if (isAbort(err)) return;
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    // A failed turn never delivers `approval_resolved`; drop this conversation's
    // paused prompt (other conversations keep theirs).
    useApprovalStore.getState().clear(conversationId);
    const msg = describeStreamError(err);
    if (msg) {
      const retry = isRetriableStreamError(err)
        ? () => void runResume(messageId, decision, note, selected)
        : null;
      s.setError(msg, retry, conversationId, streamErrorAction(err));
    }
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}

export interface SendTurnSpec {
  conversationId: string;
  content: string;
  attachments: OutgoingAttachment[];
  /** Optimistic client id of the user bubble (already added to the store).
   * After `turn_saved` reconciles it, this id is gone — the signal that the
   * turn is persisted and a retry must regenerate rather than resend. */
  optimisticUserId: string;
}

/**
 * Stream a freshly-sent user message, with a self-reinstalling retry.
 *
 * The user bubble is added optimistically by the caller before this runs. On a
 * transport failure it raises a banner whose retry re-invokes this function.
 * The retry is persistence-aware: once the backend has saved the turn (its
 * `turn_saved` swaps the optimistic id for the real one), resending would
 * duplicate the user turn, so we regenerate from the saved message instead.
 */
export async function sendTurn(spec: SendTurnSpec): Promise<void> {
  const { conversationId, content, attachments, optimisticUserId } = spec;
  const store = useConversationStore.getState();
  // Every turn write routes to this conversation's slice by id (not the active
  // key), so a turn keeps streaming into its own bubble after the user switches
  // away to another conversation.
  store.clearError(conversationId);

  // Snapshot the pre-bump position so we can undo the optimistic bump if the
  // send fails before the server ever persisted the turn.
  const beforeBump = getConversations();
  const origIndex = beforeBump.findIndex((c) => c.id === conversationId);
  const origUpdatedAt = origIndex >= 0 ? beforeBump[origIndex].updatedAt : null;
  bumpConversationCache(conversationId);

  // Persisted already? Then the optimistic id was swapped out — regenerate from
  // the saved user message rather than resending (which would duplicate it).
  const stillOptimistic = getRuntime(conversationId).messages.some(
    (m) => m.id === optimisticUserId,
  );
  if (!stillOptimistic) {
    const lastUser = [...getRuntime(conversationId).messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUser) {
      await runRegenerate(lastUser.id);
      return;
    }
  }

  // Fresh attempt: drop any partial assistant bubble left by a failed try
  // (no-op on the first send, where the user bubble is already last).
  store.truncateAfter(optimisticUserId, conversationId);

  // Open the assistant bubble now (即时反馈), before the POST even resolves —
  // mirrors runRegenerate. This flips `isGenerating` on immediately so the
  // composer shows the stop button and the bubble shows a "正在思考…" indicator
  // during the gap before the first SSE event, instead of looking like nothing
  // happened. `message_start` reuses this same bubble (ensureStreamingAssistant).
  store.createAssistantMessage(conversationId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    // 路由（双模式工作区 §一.1）：dev 开关开 + 会话绑定本机本地根 + 无附件 → 走本地
    // sidecar 引擎；否则维持现状云链路（含所有 local 会话的服务端持久化/计费）。附件需
    // 服务端上传处理，Slice 1 sidecar 不接，故有附件时退回云端不丢附件。
    const sidecarTarget =
      attachments.length === 0
        ? await resolveSidecarRoot(conversationId)
        : null;
    if (sidecarTarget) {
      await streamConversationViaSidecar({
        conversationId,
        rootId: sidecarTarget.rootId,
        subpath: sidecarTarget.subpath,
        content,
        history: buildSidecarHistory(conversationId, optimisticUserId),
        optimisticUserId,
        signal: ac.signal,
      });
    } else {
      // 云链路（默认）：桌面裸聊首发携带「待定本地容器根」（工作区对称化 D2），让服务端
      // 首次产文件时把这条裸聊懒建为该容器下的 per 对话本地文件夹（D1a）。已归档 / 云端
      // 逃生口 / 非桌面 → null（裸聊懒建走云端，现行为不变）。
      const localContainerRootId =
        await pendingLocalContainerRoot(conversationId);
      await streamConversation({
        conversationId,
        content,
        attachments,
        localContainerRootId,
        signal: ac.signal,
      });
    }
  } catch (err) {
    if (isAbort(err)) return;
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    // A failed turn never delivers `approval_resolved`; drop this conversation's
    // paused prompt (other conversations keep theirs).
    useApprovalStore.getState().clear(conversationId);
    // If the turn never persisted (no `turn_saved` reconciled the optimistic
    // id), the server order never changed — undo the optimistic bump.
    const notPersisted = getRuntime(conversationId).messages.some(
      (m) => m.id === optimisticUserId,
    );
    if (notPersisted && origIndex >= 0 && origUpdatedAt !== null) {
      restoreConversationCache(conversationId, origIndex, origUpdatedAt);
    }
    const msg = describeStreamError(err);
    if (msg) {
      const retry = isRetriableStreamError(err)
        ? () => void sendTurn(spec)
        : null;
      s.setError(msg, retry, conversationId, streamErrorAction(err));
    }
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}
