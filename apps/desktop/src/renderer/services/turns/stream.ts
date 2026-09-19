import {
  bumpConversationCache,
  getConversations,
  restoreConversationCache,
} from "@/hooks/useConversations";
import { hasLocalEngine } from "@/lib/capabilities";
import {
  StreamError,
  describeStreamError,
  isUnstartedSendRefusal,
  streamErrorAction,
} from "@/lib/errors";
import { logEvent } from "@/lib/log";
import type { SupportDiagnosticIds } from "@/lib/supportDiagnostics";
import { markSidecarUnhealthy, probeSidecar } from "@/services/sidecarHealth";
import {
  isSidecarEnabled,
  liveSidecarTarget,
  resolveConversationLocalTarget,
  resolveNewTurnBind,
  setActiveSidecarTurn,
} from "@/services/sidecarRouting";
import {
  type OutgoingAgentMention,
  type OutgoingAttachment,
  type TurnCommitReport,
  streamConversation,
} from "@/services/streamConversation";
import { streamConversationViaSidecar } from "@/services/streamConversationViaSidecar";
import {
  type CloudStreamPathReason,
  SIDECAR_OCCUPY_FAILED_CODE,
} from "@/services/streamPathReason";
import { traceTurnEnd, traceTurnMilestone } from "@/services/turnTrace";
import { restoreComposerDraft } from "@/stores/composer";
import {
  getRuntime,
  reusableSendAssistantId,
  useConversationStore,
} from "@/stores/conversation";
import {
  beginTurnPreflight,
  enterTurnStreaming,
  throwIfCannotOpenStream,
} from "@/stores/conversation/turnPhaseActions";
import { clearInteractionPrompts } from "@/stores/interactionPrompts";
import { workspaceRootGoneMessage } from "@shared/workspaceRootGone";
import { dismissRecoverableHints } from "./dismissRecovery";
import {
  finalizeGeneratingIfNeeded,
  finalizeHonestStopAbort,
  isAbort,
  isTransportDrop,
} from "./helpers";
import { sendMidFlightMessage } from "./midFlight";
import {
  cancelRejoinLiveTurn,
  rejoinLiveTurn,
  settleOrphanEmptyAssistants,
} from "./recovery";
import { runRegenerate } from "./regenerate";
import { ensureSendAssistantPlaceholder } from "./sendAssistantPlaceholder";
import { claimPrimaryStream, releasePrimaryStream } from "./streamOwnership";
import { inspectZeroOutputSendRollback } from "./zeroOutputSendRollback";

export interface SendTurnSpec {
  conversationId: string;
  content: string;
  attachments: OutgoingAttachment[];
  agentMentions?: OutgoingAgentMention[];
  /** Optimistic client id of the user bubble (already added to the store). */
  optimisticUserId: string;
  /** 必填分流；空闲开跑传 ``steer``。 */
  delivery?: "steer" | "queue";
  /** This turn's selected table row ids. Cloud POST / sidecar startTurn. */
  tableSelection?: readonly string[];
}

function setExecutionVia(
  conversationId: string,
  via: "sidecar" | "cloud_bridge" | null,
): void {
  useConversationStore.getState().setExecutionVia(via, conversationId);
}

/** 云端分支原因——写入 turnTrace + desktop.jsonl + 云 POST 头，对照服务端 via=cloud。 */
type CloudPathReason = CloudStreamPathReason;

function resolveCloudPathReason(): CloudPathReason {
  if (!hasLocalEngine()) return "no_local_engine";
  if (!isSidecarEnabled()) return "switch_off";
  return "no_local_target";
}

function logStreamPath(
  conversationId: string,
  via: "sidecar" | "cloud",
  reason: string,
  extra?: Record<string, unknown>,
): void {
  const fields = { conversation_id: conversationId, via, reason, ...extra };
  traceTurnMilestone(conversationId, "stream_path", { via, reason, ...extra });
  // 持久化到 desktop.jsonl（非仅 DEV 控制台 opt-in），便于对照服务端 via=cloud。
  logEvent("info", "turn.stream_path", fields);
}

/**
 * Stream a freshly-sent user message.
 *
 * The user bubble is added optimistically by the caller before this runs. On a
 * transport failure it raises an error banner (no one-click re-send). Once the
 * transport reports this send committed a turn (cloud: `turn_saved`; sidecar:
 * outbox flush), a later regenerate from the saved message is the
 * persistence-aware re-run path — resending would duplicate the user turn.
 *
 * 发送即有流：POST 恒返回 SSE；in-flight 时先到 ``turn_queued``（dispatch 呈现
 * 「已排队」），drain 后同连接续流——不再有 202 JSON / 另行 attach 守望。
 */
export type SendTurnResult = {
  unstartedRefusal: boolean;
  supportPack?: SupportDiagnosticIds;
};

function rollbackUnstartedOptimisticTurn(
  conversationId: string,
  userId: string,
): void {
  const store = useConversationStore.getState();
  store.truncateAfter(userId, conversationId);
  store.removeMessage(userId, conversationId);
  store.setGenerating(false, conversationId);
  store.setTurnPhase("idle", conversationId);
  store.setWaitingForWorkspaceLock(false, conversationId);
  store.setWaitingForDeskProvision(false, conversationId);
}

function surfaceTurnBanner(conversationId: string, err: unknown): void {
  const msg = describeStreamError(err);
  if (msg) {
    useConversationStore
      .getState()
      .setError(msg, null, conversationId, streamErrorAction(err));
  }
}

function streamErrorFromZeroOutput(code: string, message: string): StreamError {
  return new StreamError("http", undefined, {
    code,
    serverMessage: message || undefined,
  });
}

function thrownErrorCode(err: unknown): string | undefined {
  return err instanceof StreamError ? err.code : undefined;
}

export async function sendTurn(spec: SendTurnSpec): Promise<SendTurnResult> {
  const {
    conversationId,
    content,
    attachments,
    agentMentions = [],
    optimisticUserId,
    delivery = "steer",
    tableSelection,
  } = spec;
  const store = useConversationStore.getState();
  // A new send takes the stream — stop GET-attach retries so we never race a
  // rejoin attach against this POST (that would double-fold, not double-run).
  cancelRejoinLiveTurn(conversationId);
  // Every turn write routes to this conversation's slice by id (not the active
  // key), so a turn keeps streaming into its own bubble after the user switches
  // away to another conversation.
  store.clearError(conversationId);

  // Implicit「忽略」: a new turn dismisses recoverable 救火 hints
  // (audit + session UI latch) without clearing the execution projection.
  dismissRecoverableHints(conversationId);

  // Prior empty streaming placeholder: stop the spinner; do not invent「已中断」.
  // Keep the composer-painted bubble — settling it then minting a new id is
  // the Thinking flash (unmount + enter animation).
  const keepAssistantId = reusableSendAssistantId(
    getRuntime(conversationId).messages,
    optimisticUserId,
  );
  settleOrphanEmptyAssistants(conversationId, {
    keepMessageId: keepAssistantId,
  });

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
      return { unstartedRefusal: false };
    }
  }

  // Composer already opened Thinking behind the user bubble. Reuse that id
  // when it is still a clean placeholder; truncate only a failed-try leftover.
  // Folder workspace_lock is not held across a pause — 不得静默等锁. Residual
  // write-lock short waits emit ``workspace_lock_wait`` so the bubble shows
  // 「等待工作区…」instead of faking Thinking…. Cloud desk boot emits
  // ``desk_provision_wait`` → 「正在准备云端环境」. In-flight 同对话排队时
  // ``turn_queued`` 先到——仅 QueuedTurnsBar.
  ensureSendAssistantPlaceholder(conversationId, optimisticUserId);

  const ac = new AbortController();
  store.setAbort(ac, conversationId);
  beginTurnPreflight(conversationId);
  // 探活窗口起即占主路——midFlight 排队缓冲等到本回合整段泵（含 finally）释放。
  const primaryToken = claimPrimaryStream(conversationId);
  const turnCommit: TurnCommitReport = { committed: false };
  try {
    traceTurnMilestone(conversationId, "send_start");
    // 路由（双模式工作区 §7.2）：本机传统默认同侧 sidecar =
    //   有本地引擎 + 未显式强制关（sidecarPreference!=="off"；unset 不挡）+ 活本机绑定。
    // 贴文件不改场地：区内引用 / 区外复制进 attachments/ 都跟绑定走。
    // 云链路：纯云会话 / 显式强制关。探活失败与启动期失败出诊断横幅，不自动过桥。
    // 死绑定：授权根在表、空子路径目录已不在盘 → 横幅，不 probe、不走云。
    // 点名是 prompt 软提示，不挡本机。resolveNewTurnBind 早退不 probe；
    // 健康由下方 probe 仅在有 live target 时收敛。
    const bind = await resolveNewTurnBind(conversationId);
    if (bind.kind === "stale") {
      logStreamPath(conversationId, "sidecar", "root_stale", {
        root_id: bind.rootId,
      });
      throw new StreamError("sidecar", undefined, {
        serverMessage: workspaceRootGoneMessage(bind.absPath),
      });
    }
    const sidecarTarget = liveSidecarTarget(bind);
    throwIfCannotOpenStream(conversationId, ac.signal);
    traceTurnMilestone(conversationId, "sidecar_resolve", {
      target: sidecarTarget
        ? { rootId: sidecarTarget.rootId, subpath: sidecarTarget.subpath }
        : null,
    });
    // 首次真正走 sidecar 前探活一次：拉起进程 + 握手。环境起不来则本轮报错；
    // `probeSidecar` 已按根记下 `bad`（带 TTL），命中缓存时 probed:false——同样报错，不走云。
    const probe = sidecarTarget ? await probeSidecar(sidecarTarget) : null;
    throwIfCannotOpenStream(conversationId, ac.signal);
    if (probe) {
      traceTurnMilestone(conversationId, "sidecar_probe", {
        healthy: probe.healthy,
        probed: probe.probed,
      });
    }
    if (sidecarTarget && probe && !probe.healthy) {
      const reason = probe.probed ? "probe_unhealthy" : "probe_cache_bad";
      logStreamPath(conversationId, "sidecar", reason, {
        root_id: sidecarTarget.rootId,
        probe_detail: probe.detail,
      });
      throw new StreamError("sidecar", undefined, {
        serverMessage: probe.detail?.trim() || "本地引擎未能启动",
      });
    }
    if (sidecarTarget && probe?.healthy) {
      setExecutionVia(conversationId, "sidecar");
      logStreamPath(conversationId, "sidecar", "probe_ok", {
        root_id: sidecarTarget.rootId,
        subpath: sidecarTarget.subpath,
      });
      try {
        throwIfCannotOpenStream(conversationId, ac.signal);
        enterTurnStreaming(conversationId);
        await streamConversationViaSidecar({
          conversationId,
          rootId: sidecarTarget.rootId,
          subpath: sidecarTarget.subpath,
          content,
          optimisticUserId,
          attachments,
          agentMentions,
          tableSelection,
          signal: ac.signal,
          turnCommit,
        });
      } catch (sidecarErr) {
        // 忙槽：上一轮还在跑。不当失败脸，改走插队/排队（与生成中再发同一条）。
        if (
          sidecarErr instanceof StreamError &&
          sidecarErr.code === "sidecar_turn_busy"
        ) {
          store.truncateAfter(optimisticUserId, conversationId);
          await sendMidFlightMessage(
            conversationId,
            content,
            attachments.length > 0 ? attachments : undefined,
            delivery,
            agentMentions.length > 0 ? agentMentions : undefined,
            {
              sidecarTarget,
              userMessageId: optimisticUserId,
              tableSelection,
            },
          );
          useConversationStore.getState().setGenerating(true, conversationId);
          enterTurnStreaming(conversationId);
          setActiveSidecarTurn(
            conversationId,
            sidecarTarget.rootId,
            sidecarTarget.subpath,
          );
          return { unstartedRefusal: false };
        }
        // 启动期 recoverable：引擎没起来 → 记坏 + 横幅（不降级云）。
        // 云端占位失败不是引擎坏了 → 改走云 POST，不记坏、不写过桥脚注。
        // 中途失败与用户停止不在此列。
        if (
          !(sidecarErr instanceof StreamError) ||
          sidecarErr.kind !== "sidecar" ||
          !sidecarErr.recoverable
        ) {
          throw sidecarErr;
        }
        const fallbackDetail =
          sidecarErr.serverMessage?.trim() || "本地引擎未能启动";
        if (sidecarErr.code === SIDECAR_OCCUPY_FAILED_CODE) {
          setExecutionVia(conversationId, null);
          ensureSendAssistantPlaceholder(conversationId, optimisticUserId);
          beginTurnPreflight(conversationId);
          throwIfCannotOpenStream(conversationId, ac.signal);
          logStreamPath(conversationId, "cloud", "occupy_failed", {
            root_id: sidecarTarget.rootId,
            detail: fallbackDetail,
          });
          enterTurnStreaming(conversationId);
          await streamConversation({
            conversationId,
            content,
            attachments,
            agentMentions,
            delivery,
            signal: ac.signal,
            turnCommit,
            streamPathReason: "occupy_failed",
          });
        } else {
          markSidecarUnhealthy(sidecarTarget, fallbackDetail);
          logStreamPath(conversationId, "sidecar", "start_failed", {
            root_id: sidecarTarget.rootId,
            detail: fallbackDetail,
          });
          throw sidecarErr;
        }
      }
    } else {
      // 云链路：显式强制关 / 无本机引擎 / 纯云会话。
      const bridging =
        sidecarTarget !== null ||
        (await resolveConversationLocalTarget(conversationId)) !== null;
      setExecutionVia(conversationId, bridging ? "cloud_bridge" : null);
      const reason = resolveCloudPathReason();
      logStreamPath(conversationId, "cloud", reason, {
        bridging,
        root_id: sidecarTarget?.rootId ?? null,
        probe_detail: probe?.detail ?? null,
      });
      // 本地意向已是会话状态（Conversation.local_container_root_id，建会话时定型，
      // 工作区对称化 D1a），服务端据此在裸聊首次产文件时懒建本地 / 云端文件夹——
      // 回合不再携带容器根。
      throwIfCannotOpenStream(conversationId, ac.signal);
      enterTurnStreaming(conversationId);
      await streamConversation({
        conversationId,
        content,
        attachments,
        agentMentions,
        delivery,
        signal: ac.signal,
        turnCommit,
        streamPathReason: reason,
        tableSelection,
      });
    }
    const zero = inspectZeroOutputSendRollback(
      conversationId,
      turnCommit.committed,
      { optimisticUserId },
    );
    if (zero) {
      // SSE error 后 stream 常 resolve：本发已提交 + 空失败 + Class B 码也要回滚。
      rollbackUnstartedOptimisticTurn(conversationId, zero.userId);
      surfaceTurnBanner(
        conversationId,
        streamErrorFromZeroOutput(zero.error.code, zero.error.message),
      );
      traceTurnEnd(conversationId, "error");
      return { unstartedRefusal: true, supportPack: zero.supportPack };
    }
    traceTurnEnd(conversationId, "ok");
    return { unstartedRefusal: false };
  } catch (err) {
    if (isAbort(err)) {
      const zero = inspectZeroOutputSendRollback(
        conversationId,
        turnCommit.committed,
        { optimisticUserId },
      );
      if (zero) {
        rollbackUnstartedOptimisticTurn(conversationId, zero.userId);
        traceTurnEnd(conversationId, "abort");
        return { unstartedRefusal: true };
      }
      finalizeHonestStopAbort(conversationId, err);
      traceTurnEnd(conversationId, "abort");
      return { unstartedRefusal: false };
    }
    // A mid-stream drop no longer means the turn died (1a: it runs detached) —
    // rejoin it live (1b) rather than resending, which would duplicate the turn.
    // Sidecar 失败（探活 / 启动期 / 中途）kind 是 "sidecar" 不是 "network"，不走 rejoin。
    if (isTransportDrop(err) && (await rejoinLiveTurn(conversationId))) {
      traceTurnEnd(conversationId, "ok");
      return { unstartedRefusal: false };
    }
    if (isTransportDrop(err)) {
      // 断线可能仍在跑：不要还字。重连失败只收口生成态。
      if (!turnCommit.committed && origIndex >= 0 && origUpdatedAt !== null) {
        restoreConversationCache(conversationId, origIndex, origUpdatedAt);
      }
      clearInteractionPrompts(conversationId);
      finalizeGeneratingIfNeeded(conversationId);
      surfaceTurnBanner(conversationId, err);
      traceTurnEnd(conversationId, "error");
      return { unstartedRefusal: false };
    }
    // A failed turn never delivers `approval_resolved`; drop this conversation's
    // paused prompt (other conversations keep theirs).
    clearInteractionPrompts(conversationId);
    // If the turn never committed (no `turn_saved` / outbox flush this send),
    // the server order never changed — undo the optimistic bump.
    if (!turnCommit.committed && origIndex >= 0 && origUpdatedAt !== null) {
      restoreConversationCache(conversationId, origIndex, origUpdatedAt);
    }
    const unstartedRefusal =
      !turnCommit.committed && isUnstartedSendRefusal(err);
    const zero = unstartedRefusal
      ? null
      : inspectZeroOutputSendRollback(conversationId, turnCommit.committed, {
          optimisticUserId,
          thrownCode: thrownErrorCode(err),
        });
    if (unstartedRefusal) {
      // 发送当没发生：撤乐观用户泡 + 空助手泡，phase 回 idle（failed 会挡下一发）。
      rollbackUnstartedOptimisticTurn(conversationId, optimisticUserId);
    } else if (zero) {
      rollbackUnstartedOptimisticTurn(conversationId, zero.userId);
    } else {
      finalizeGeneratingIfNeeded(conversationId);
    }
    surfaceTurnBanner(conversationId, err);
    traceTurnEnd(conversationId, "error");
    return {
      unstartedRefusal: unstartedRefusal || zero != null,
      ...(zero ? { supportPack: zero.supportPack } : {}),
    };
  } finally {
    // 仅清自己的 abort——midFlight 排队续流可能已接手同一会话的 abort 槽。
    if (getRuntime(conversationId).abort === ac) {
      useConversationStore.getState().setAbort(null, conversationId);
    }
    releasePrimaryStream(conversationId, primaryToken);
  }
}

/** 续写被截断的回答 (对话基础功能补齐): the latest reply ended early (用户叫停 / 达最大轮次),
 * so「继续生成」sends a minimal continuation turn — with the transcript in context, the model
 * picks up where it left off. Mirrors the composer's optimistic-send shape (add the user
 * bubble, then stream). No-op while a
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
  const result = await sendTurn({
    conversationId,
    content: "继续",
    attachments: [],
    optimisticUserId: userMsgId,
  });
  if (result.unstartedRefusal) {
    restoreComposerDraft(conversationId, {
      value: "继续",
      attachments: [],
      agentMentions: [],
    });
  }
}
