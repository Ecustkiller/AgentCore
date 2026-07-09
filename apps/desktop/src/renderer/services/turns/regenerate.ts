import { bumpConversationCache } from "@/hooks/useConversations";
import {
  describeStreamError,
  isRetriableStreamError,
  streamErrorAction,
} from "@/lib/errors";
import type { PlanReviewUserDecision } from "@/services/planReview";
import { isClientOnlyResumeKey } from "@/services/resume";
import { clearSidecarHealth, probeSidecar } from "@/services/sidecarHealth";
import {
  type SidecarTarget,
  resolveSidecarRoot,
} from "@/services/sidecarRouting";
import {
  regenerateConversation,
  resumeConversation,
  retryFailedConversation,
} from "@/services/streamConversation";
import { resumeConversationViaSidecar } from "@/services/streamConversationViaSidecar";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import type { PendingResume } from "@/stores/pausedTurns";
import { isAbort, isTransportDrop } from "./helpers";
import { rejoinLiveTurn } from "./recovery";

/** Whether a durable resume should route to the local sidecar engine. */
function shouldResumeViaSidecar(
  pending: PendingResume | undefined,
  sidecarTarget: SidecarTarget | null,
): boolean {
  if (!pending || !sidecarTarget) return false;
  return pending.origin === "sidecar";
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
    // A mid-stream drop no longer means the turn died (1a: it runs detached) —
    // rejoin it live (1b) rather than regenerating, which would double-run it.
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) return;
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    // A failed turn never delivers `approval_resolved`; drop this conversation's
    // paused prompt (other conversations keep theirs).
    clearInteractionPrompts(conversationId);
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
 * Retry only the failed worker nodes from the previous turn's execution.
 *
 * Unlike runRegenerate (which re-runs everything from scratch), this tells
 * the backend to reuse completed worker results and only re-run the failed
 * ones — saving time and cost when most workers succeeded.
 */
export async function runRetryFailed(userMessageId: string): Promise<void> {
  const store = useConversationStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId || getRuntime(conversationId).isGenerating) return;

  store.clearError(conversationId);
  bumpConversationCache(conversationId);
  store.truncateAfter(userMessageId, conversationId);
  store.createAssistantMessage(conversationId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    await retryFailedConversation({
      conversationId,
      messageId: userMessageId,
      signal: ac.signal,
    });
  } catch (err) {
    if (isAbort(err)) return;
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) return;
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    clearInteractionPrompts(conversationId);
    const msg = describeStreamError(err);
    if (msg) {
      const retry = isRetriableStreamError(err)
        ? () => void runRetryFailed(userMessageId)
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
  if (!conversationId || getRuntime(conversationId).isGenerating) {
    console.warn(
      `[Resume] runResume early return messageId=${messageId} decision=${decision} conversationId=${conversationId ?? "null"} isGenerating=${conversationId ? getRuntime(conversationId).isGenerating : "n/a"}`,
    );
    return;
  }

  console.warn(
    `[Resume] runResume start messageId=${messageId} decision=${decision} conversationId=${conversationId}`,
  );

  store.clearError(conversationId);
  bumpConversationCache(conversationId);

  // Route durable resume the same way as a send: a conversation bound to a present
  // local root resumes on the sidecar engine (双模式工作区 §一.1); else the cloud.
  // Capture the pending frame BEFORE removing it — the sidecar path needs its
  // original user message text and the pinned user bubble id for write-back.
  const sidecarTarget = await resolveSidecarRoot(conversationId);
  const pending = usePausedTurnStore
    .getState()
    .pending.find((p) => p.messageId === messageId);
  const sidecarResume = shouldResumeViaSidecar(pending, sidecarTarget);

  console.warn(
    `[Resume] runResume routing messageId=${messageId} decision=${decision} conversationId=${conversationId} sidecarResume=${sidecarResume} sidecarRootId=${sidecarTarget?.rootId ?? "null"} pendingFound=${pending !== undefined} origin=${pending?.origin ?? "none"}`,
  );

  // A paused sidecar frame lives ONLY on this machine and can only be continued by
  // the local engine — the cloud has no such frame, so (unlike a fresh send) resume
  // must NOT degrade to cloud. Probe first: if the env can't start, keep the resume
  // card (don't remove the pending frame) and raise a retry banner, so the user can
  // fix the env and retry — never a guaranteed-404 cloud resume. (probeSidecar has
  // marked the root bad, so subsequent fresh sends silently go cloud.)
  if (sidecarResume && sidecarTarget) {
    const probe = await probeSidecar(sidecarTarget);
    if (!probe.healthy) {
      console.warn(
        `[Resume] runResume sidecar probe failed messageId=${messageId} decision=${decision} conversationId=${conversationId} detail=${probe.detail ?? "null"}`,
      );
      store.setError(
        probe.detail
          ? `${probe.detail}，本地引擎暂不可用，无法继续这次暂停的回合，请稍后重试`
          : "本地引擎暂不可用，无法继续这次暂停的回合，请稍后重试",
        // 手动重试 = 用户「我修好环境了，再试一次」的明确信号——先清会话级健康缓存强制重探，
        // 否则重试必命中刚记下的 bad 缓存、变成死按钮（与「请稍后重试」矛盾）。清空是全局的，
        // 但这正合「重新评估本地引擎」之意（环境修复通常是全局的：关杀软 / 修 venv）。
        () => {
          clearSidecarHealth();
          void runResume(messageId, decision, note, selected);
        },
        conversationId,
        null,
      );
      return;
    }
  }

  if (isClientOnlyResumeKey(conversationId, messageId)) {
    console.warn(
      `[Resume] runResume rejected: client-only resume key messageId=${messageId} decision=${decision} conversationId=${conversationId}`,
    );
    store.setError(
      "续跑键无效（缺少服务端消息 ID），请关闭并重新打开会话后重试",
      () => void runResume(messageId, decision, note, selected),
      conversationId,
      null,
    );
    return;
  }

  store.createAssistantMessage(conversationId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    if (sidecarResume && pending && sidecarTarget) {
      const userMessageId =
        pending.userMessageId ||
        [...getRuntime(conversationId).messages]
          .reverse()
          .find((m) => m.role === "user")?.id ||
        "";
      console.warn(
        `[Resume] runResume calling sidecar resume messageId=${messageId} decision=${decision} conversationId=${conversationId} userMessageId=${userMessageId}`,
      );
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
      console.warn(
        `[Resume] runResume sidecar resume completed messageId=${messageId} decision=${decision} conversationId=${conversationId}`,
      );
      usePausedTurnStore.getState().remove(messageId);
    } else {
      console.warn(
        `[Resume] runResume calling cloud resume messageId=${messageId} decision=${decision} conversationId=${conversationId}`,
      );
      await resumeConversation({
        conversationId,
        messageId,
        decision,
        note,
        selected,
        signal: ac.signal,
      });
      console.warn(
        `[Resume] runResume cloud resume completed messageId=${messageId} decision=${decision} conversationId=${conversationId}`,
      );
      usePausedTurnStore.getState().remove(messageId);
    }
  } catch (err) {
    if (isAbort(err)) {
      console.warn(
        `[Resume] runResume aborted messageId=${messageId} decision=${decision} conversationId=${conversationId}`,
      );
      return;
    }
    // A mid-stream drop no longer means the turn died (1a: it runs detached) —
    // rejoin it live (1b) rather than re-resuming, which would double-run it.
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) {
      console.warn(
        `[Resume] runResume transport drop, rejoined live messageId=${messageId} decision=${decision} conversationId=${conversationId}`,
      );
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Resume] runResume failed messageId=${messageId} decision=${decision} conversationId=${conversationId} err=${errMsg}`,
    );
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    // A failed turn never delivers `approval_resolved`; drop this conversation's
    // paused prompt (other conversations keep theirs).
    clearInteractionPrompts(conversationId);
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
