import {
  bumpConversationCache,
  getConversations,
  restoreConversationCache,
} from "@/hooks/useConversations";
import {
  StreamError,
  describeStreamError,
  isRetriableStreamError,
  streamErrorAction,
} from "@/lib/errors";
import { notifyInfo } from "@/lib/toast";
import { loadLatestWindow } from "@/services/messages";
import type { PlanReviewUserDecision } from "@/services/planReview";
import {
  clearSidecarHealth,
  markSidecarUnhealthy,
  probeSidecar,
} from "@/services/sidecarHealth";
import {
  buildSidecarHistory,
  resolveSidecarRoot,
} from "@/services/sidecarRouting";
import {
  type OutgoingAttachment,
  attachConversation,
  regenerateConversation,
  resumeConversation,
  streamConversation,
} from "@/services/streamConversation";
import {
  resumeConversationViaSidecar,
  streamConversationViaSidecar,
} from "@/services/streamConversationViaSidecar";
import { traceTurnEnd, traceTurnMilestone } from "@/services/turnTrace";
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

/** A mid-stream transport drop (socket died), as opposed to a backend refusal
 * (quota / rate limit / missing key, which never started a run). Only a drop
 * warrants RECONNECT — since 执行与请求解耦 (C1 · slice 1a) the turn keeps running
 * detached, so the right recovery is to rejoin it (1b), not resend it. */
function isTransportDrop(err: unknown): boolean {
  return err instanceof StreamError && err.kind === "network";
}

/** zh banner for a reconnect that could not be held — the run is still alive in
 * the background, so the action reconnects rather than resends. */
const RECONNECT_BANNER = "连接中断，回合仍在后台继续。点击「重连」继续查看。";

/** The latest user message of a conversation's slice, or null. */
function lastUserMessageOf(conversationId: string): Message | null {
  const msgs = getRuntime(conversationId).messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i];
  }
  return null;
}

/**
 * Rejoin a turn whose live stream dropped mid-flight (实时重连续看 C1 · slice 1b).
 *
 * Post-decoupling (slice 1a) a dropped connection no longer kills a turn — it
 * runs detached + persists — so a transport drop must RECONNECT, not resend (a
 * resend / regenerate would double-run a turn that is still alive). Resets the
 * partial assistant bubble (the replay re-sends the full transcript-so-far, so
 * keeping the partial would double it), then attaches: replay + live tail. On
 * `"none"` the run already finished — reload the persisted transcript (its reply
 * is saved). If reconnect itself drops, surface a banner whose retry reconnects
 * again (never resends).
 *
 * Returns `true` when handled (reattached / reloaded a saved reply / banner shown);
 * `false` only when there is no turn to rejoin and nothing was persisted, so the
 * caller can fall back to its resend / regenerate banner.
 */
export async function rejoinLiveTurn(conversationId: string): Promise<boolean> {
  const lastUser = lastUserMessageOf(conversationId);
  if (!lastUser) return false;

  const store = useConversationStore.getState();
  store.clearError(conversationId);
  // Drop any partial assistant bubble so the replay rebuilds it cleanly, then open
  // a fresh placeholder for instant feedback (message_start reuses it).
  store.truncateAfter(lastUser.id, conversationId);
  store.createAssistantMessage(conversationId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    const outcome = await attachConversation(conversationId, ac.signal);
    if (outcome === "attached") return true;
    // No live run — the detached turn already finished + persisted. Reload it so
    // the placeholder is replaced by the saved reply.
    await loadLatestWindow(conversationId);
    useConversationStore.getState().setGenerating(false, conversationId);
    const last = getRuntime(conversationId).messages.at(-1);
    // A persisted assistant reply means the detached turn delivered — handled.
    // Still ending on the user message means it produced nothing → let the caller
    // offer a resend.
    return last?.role === "assistant";
  } catch (err) {
    if (isAbort(err)) return true; // user stopped — handled
    const s = useConversationStore.getState();
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
    }
    useApprovalStore.getState().clear(conversationId);
    // A reconnect drop → manual「重连」(never resend); an auth failure stays silent
    // (the api layer already redirected to login).
    const msg = isTransportDrop(err)
      ? RECONNECT_BANNER
      : describeStreamError(err);
    if (msg) {
      s.setError(
        msg,
        () => void rejoinLiveTurn(conversationId),
        conversationId,
        streamErrorAction(err),
      );
    }
    return true;
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}

/**
 * On opening a conversation whose latest turn has no persisted reply yet, rejoin a
 * run that may still be live (实时重连续看 C1 · slice 1b — reopen the app / revisit
 * and 续看 it finish).
 *
 * Unlike {@link rejoinLiveTurn} this has no partial bubble to reset (the reopened
 * transcript ends at the user message); it attaches bare, and the replay's
 * `message_start` opens the bubble — so a 204 (nothing live) is a clean no-op with
 * no flicker. A drop while attached offers a manual reconnect.
 */
export async function attachOnOpen(conversationId: string): Promise<void> {
  const store = useConversationStore.getState();
  if (getRuntime(conversationId).isGenerating) return; // already streaming locally

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  try {
    await attachConversation(conversationId, ac.signal);
  } catch (err) {
    if (isAbort(err)) return;
    const s = useConversationStore.getState();
    // Only surface a reconnect banner if a bubble actually opened (a run was live
    // and we lost it); a pre-event drop / 204 stays silent.
    if (getRuntime(conversationId).isGenerating) {
      s.finalizeLastMessage(conversationId);
      s.setError(
        RECONNECT_BANNER,
        () => void rejoinLiveTurn(conversationId),
        conversationId,
        null,
      );
    }
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
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
    // A mid-stream drop no longer means the turn died (1a: it runs detached) —
    // rejoin it live (1b) rather than regenerating, which would double-run it.
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) return;
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
  const sidecarResume = sidecarTarget !== null && pending !== undefined;

  // A paused sidecar frame lives ONLY on this machine and can only be continued by
  // the local engine — the cloud has no such frame, so (unlike a fresh send) resume
  // must NOT degrade to cloud. Probe first: if the env can't start, keep the resume
  // card (don't remove the pending frame) and raise a retry banner, so the user can
  // fix the env and retry — never a guaranteed-404 cloud resume. (probeSidecar has
  // marked the root bad, so subsequent fresh sends silently go cloud.)
  if (sidecarResume && sidecarTarget) {
    const probe = await probeSidecar(sidecarTarget);
    if (!probe.healthy) {
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

  // Probe passed (or a cloud resume) → claim the frame: optimistically drop the
  // resume card (the server claim is atomic, so a stale / second attempt 404s).
  usePausedTurnStore.getState().remove(messageId);

  // A paused sidecar turn's user message was never written to the cloud (it paused
  // before write-back), so it is absent from the reopened transcript. Inject it back
  // (with a fresh id the completion write-back will pin) so the continuation reads
  // naturally and reconciles cleanly. Cloud resume already has its user row loaded.
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
    // A mid-stream drop no longer means the turn died (1a: it runs detached) —
    // rejoin it live (1b) rather than re-resuming, which would double-run it.
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) return;
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
    traceTurnMilestone(conversationId, "send_start");
    // 路由（双模式工作区 §一.1）：开关开（默认开）+ 会话绑定本机本地根 + 无附件 → 走本地
    // sidecar 引擎；否则维持现状云链路（含所有 local 会话的服务端持久化/计费）。附件需
    // 服务端上传处理，Slice 1 sidecar 不接，故有附件时退回云端不丢附件。
    const sidecarTarget =
      attachments.length === 0
        ? await resolveSidecarRoot(conversationId)
        : null;
    traceTurnMilestone(conversationId, "sidecar_resolve", {
      target: sidecarTarget
        ? { rootId: sidecarTarget.rootId, subpath: sidecarTarget.subpath }
        : null,
    });
    // 首次真正走 sidecar 前探活一次（探活增强）：拉起进程 + 握手验证本机环境能起得来。环境起
    // 不来则本轮落到下方云分支；`probeSidecar` 已按根记下 `bad`，后续回合探活直接命中缓存
    // （probed:false）→ 静默走云、不再打扰。故只在**首探失败**（probed）时提示一次。已探明 ok
    // 的根命中缓存直接复用、不重探。
    const probe = sidecarTarget ? await probeSidecar(sidecarTarget) : null;
    if (probe) {
      traceTurnMilestone(conversationId, "sidecar_probe", {
        healthy: probe.healthy,
        probed: probe.probed,
      });
    }
    if (sidecarTarget && probe && !probe.healthy && probe.probed) {
      notifyInfo(
        probe.detail
          ? `${probe.detail}，已自动用云端`
          : "本地引擎未能在此环境启动，已自动用云端",
      );
    }
    if (sidecarTarget && probe?.healthy) {
      traceTurnMilestone(conversationId, "stream_path", { via: "sidecar" });
      try {
        await streamConversationViaSidecar({
          conversationId,
          rootId: sidecarTarget.rootId,
          subpath: sidecarTarget.subpath,
          content,
          history: buildSidecarHistory(conversationId, optimisticUserId),
          optimisticUserId,
          signal: ac.signal,
        });
      } catch (sidecarErr) {
        // 探活已过、但回合「启动期」仍失败的边缘（拉不起 / 握手失败，一个事件都没派发 →
        // recoverable）：本轮还没产生任何输出 / 副作用，故安全改走云链路重跑、用户无感。同时标记
        // 该根坏 → 后续回合 resolveSidecarRoot 直接跳过、不再每轮降级（与探活共用同一「记坏 →
        // 跳过」出口，不另起一条降级路径）。中途失败（已流式 / 已调工具）与用户停止不在此列——
        // 照常抛给下方通用处理走「本地引擎出错」横幅 + 重试，绝不重复已发生的副作用。
        if (
          !(sidecarErr instanceof StreamError) ||
          sidecarErr.kind !== "sidecar" ||
          !sidecarErr.recoverable
        ) {
          throw sidecarErr;
        }
        markSidecarUnhealthy(sidecarTarget);
        notifyInfo("本地引擎未能启动，已自动用云端完成这次对话");
        store.truncateAfter(optimisticUserId, conversationId);
        store.createAssistantMessage(conversationId);
        traceTurnMilestone(conversationId, "stream_path", {
          via: "cloud",
          reason: "sidecar_fallback",
        });
        await streamConversation({
          conversationId,
          content,
          attachments,
          signal: ac.signal,
        });
      }
    } else {
      traceTurnMilestone(conversationId, "stream_path", { via: "cloud" });
      // 云链路（默认，含探活失败的 fallthrough）。本地意向已是会话状态
      // （Conversation.local_container_root_id，建会话时定型，工作区对称化 D1a），
      // 服务端据此在裸聊首次产文件时懒建本地 / 云端文件夹——回合不再携带容器根。
      await streamConversation({
        conversationId,
        content,
        attachments,
        signal: ac.signal,
      });
    }
    traceTurnEnd(conversationId, "ok");
  } catch (err) {
    if (isAbort(err)) {
      const s = useConversationStore.getState();
      if (getRuntime(conversationId).isGenerating) {
        s.finalizeLastMessage(conversationId);
      }
      traceTurnEnd(conversationId, "abort");
      return;
    }
    // A mid-stream drop no longer means the turn died (1a: it runs detached) —
    // rejoin it live (1b) rather than resending, which would duplicate the turn.
    // (A sidecar engine failure is kind "sidecar", not "network", so a local turn
    // skips this and keeps its resend banner. A *startup* sidecar failure was
    // already rerouted to cloud upstream (阶段二), so one reaching here is
    // necessarily mid-run — never auto-rerouted, to avoid repeating side effects.)
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) {
      traceTurnEnd(conversationId, "ok");
      return;
    }
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
    traceTurnEnd(conversationId, "error");
  } finally {
    useConversationStore.getState().setAbort(null, conversationId);
  }
}

/**
 * Send a plain-text turn into the ACTIVE conversation from a non-composer surface
 * (the canvas 老板命令栏, 前端UX设计.md §6.1「下达指令」). A reduced twin of the
 * message composer's full `handleSend`: it assumes an existing active conversation
 * and no attachments / background mode / new-conversation creation — just the
 * optimistic user bubble + {@link sendTurn}. No-op (returns false) for blank input,
 * with no active conversation, or while a turn is already generating (turns don't
 * stack — the caller disables its send affordance too); returns true once a turn
 * was dispatched.
 */
export async function sendQuickTurn(content: string): Promise<boolean> {
  const trimmed = content.trim();
  if (!trimmed) return false;
  const store = useConversationStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId) return false;
  if (getActiveRuntime().isGenerating) return false;
  // Reading history (a search-hit jump left newer messages unloaded)? Snap back to
  // the live head so the turn lands at the true tail (live-head invariant).
  if (getActiveRuntime().hasMoreAfter) {
    try {
      await loadLatestWindow(conversationId);
    } catch {
      /* best-effort: append at the current tail */
    }
  }
  const userMsgId = crypto.randomUUID();
  store.addMessage({
    id: userMsgId,
    role: "user",
    content: trimmed,
    createdAt: new Date().toISOString(),
    executionId: null,
    isStreaming: false,
  });
  await sendTurn({
    conversationId,
    content: trimmed,
    attachments: [],
    optimisticUserId: userMsgId,
  });
  return true;
}
