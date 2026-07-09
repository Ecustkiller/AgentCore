import type { DebateSeed } from "@/components/chat/debate/seed";
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
import { markSidecarUnhealthy, probeSidecar } from "@/services/sidecarHealth";
import {
  buildSidecarHistory,
  resolveSidecarRoot,
} from "@/services/sidecarRouting";
import {
  type OutgoingAttachment,
  streamConversation,
} from "@/services/streamConversation";
import { streamConversationViaSidecar } from "@/services/streamConversationViaSidecar";
import { traceTurnEnd, traceTurnMilestone } from "@/services/turnTrace";
import {
  getActiveRuntime,
  getRuntime,
  useConversationStore,
} from "@/stores/conversation";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import { isAbort, isTransportDrop } from "./helpers";
import { rejoinLiveTurn } from "./recovery";
import { runRegenerate } from "./regenerate";

export interface SendTurnSpec {
  conversationId: string;
  content: string;
  attachments: OutgoingAttachment[];
  /** Optimistic client id of the user bubble (already added to the store).
   * After `turn_saved` reconciles it, this id is gone — the signal that the
   * turn is persisted and a retry must regenerate rather than resend. */
  optimisticUserId: string;
  /** 续辩种子（结构化补轮·B / 可逆叫停）：非空 = 本回合从某场收场辩论续辩（debate 续上一场）。
   *  随回合载荷直传引擎（sidecar 与云链路同形），普通回合缺省。 */
  debateSeed?: DebateSeed;
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
  const { conversationId, content, attachments, optimisticUserId, debateSeed } =
    spec;
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
          debateSeed,
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
          debateSeed,
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
        debateSeed,
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
    clearInteractionPrompts(conversationId);
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

/** 续写被截断的回答 (对话基础功能补齐): the latest reply ended early (用户叫停 / 达最大轮次),
 * so「继续生成」sends a minimal continuation turn — with the transcript in context, the model
 * picks up where it left off. Mirrors the composer's optimistic-send shape (add the user
 * bubble, then stream) so the retry-banner / reconcile paths work unchanged. No-op while a
 * turn is already streaming. */
export async function continueTurn(conversationId: string): Promise<void> {
  if (getRuntime(conversationId).isGenerating) return;
  const userMsgId = crypto.randomUUID();
  useConversationStore.getState().addMessage(
    {
      id: userMsgId,
      role: "user",
      content: "继续",
      createdAt: new Date().toISOString(),
      executionId: null,
      isStreaming: false,
    },
    conversationId,
  );
  await sendTurn({
    conversationId,
    content: "继续",
    attachments: [],
    optimisticUserId: userMsgId,
  });
}

/**
 * 续辩（结构化补轮·B / 可逆叫停，辩论编排设计.md §6.6）：从一张【已收场】的
 * 辩论卡发起「再辩一轮 / 换角度」——往**当前活跃会话**发一个携 `debate_seed` 的新回合（新 turn =
 * 新辩论卡，守事件源 turn 模型、不原地改写上一场）。`content` 是给 CEO 的续辩指令（含原命题 +
 * 可选新角度），`seed` 让本回合的 debate 续上一场（主持人焦点正交于已谈、首轮辩手读到上一场摘要）。
 *
 * 乐观气泡 + {@link sendTurn}、只多带种子（画布/聊天的常规下达指令则走统一 composer 管线
 * `useComposerSend`）；空 `content` / 无活跃会话 / 正在生成 → no-op 返回 false（回合不叠加）。
 */
export async function sendDebateContinuation(
  content: string,
  seed: DebateSeed,
): Promise<boolean> {
  const trimmed = content.trim();
  if (!trimmed) return false;
  const store = useConversationStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId) return false;
  if (getActiveRuntime().isGenerating) return false;
  // 读历史中（搜索跳转留下更新的消息未加载）：先回到 live head，使续辩落到真正的队尾。
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
    debateSeed: seed,
  });
  return true;
}
