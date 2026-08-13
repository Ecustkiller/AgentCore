/**
 * Open-time attach/settle after message-window fetch (P4 unified hydrate).
 *
 * Decoupled from message-window adopt and from hydrate UI ready: ConversationPage
 * reveals after adopt (+ recovery await); this runs in the background (void).
 * Warm reopen keeps the in-memory slice (adopt skips overwrite) but still runs
 * recovery-driven attach/settle so a detached live / ghost running assistant is
 * not left stuck in a fake generating state.
 *
 * 观察泵挂在会话切片上：切会话 ≠ 卸观察。本路径不接受页级 AbortSignal；
 * 显式卸观察仅由 `attachSidecarTurn({ signal })` 调用方传入。
 */
import { logEvent } from "@/lib/log";
import {
  type ConversationRecovery,
  shouldHydrateLocalRecovery,
} from "@/services/resume";
import { clearAiAttentionForConversation } from "@/stores/aiAttention";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { syncConversationFollow } from "./conversationFollow";
import { projectPausedRuns } from "./projectPausedRuns";
import { projectUnsyncedTurns } from "./projectUnsynced";
import {
  attachOnOpen,
  settleCloudRunningAssistant,
  settleOrphanEmptyAssistants,
} from "./recovery";
import { attachSidecarTurn } from "./sidecarAttach";

/**
 * Branch on recovery facts and rejoin / settle / project unsynced.
 *
 * Cloud path reads the **runtime** tail message (not the fetched window): after
 * a successful cold adopt they match; on warm reopen memory may already be newer.
 */
export async function runHydrateAttachSettle(
  conversationId: string,
  recovery: ConversationRecovery,
): Promise<"local" | "cloud"> {
  const useLocal = shouldHydrateLocalRecovery(recovery);
  logEvent("info", "conversation.hydrate", {
    conversation_id: conversationId,
    sidecar_live: recovery.sidecarLive,
    cloud_live: recovery.cloudLive,
    unsynced_count: recovery.unsynced.length,
    paused_count: recovery.pausedCount,
    branch: useLocal ? "local" : "cloud",
  });
  // 对话级订阅（云对话多端同权 B2 · 验收 4）：云会话常驻一条 ``follow=true`` 订阅，
  // 空闲只收心跳，另一端开跑的新回合在同一条流上自动重放 + 跟播。本机引擎在跑 / 有本机
  // 未同步回合时不订（那些回合服务端没有 run）；纯云的冷挂起会话要订——另一端放行后的
  // 续跑就是一个新 run。放在 abort 早退之前：订阅自带本端连接闸，忙时自己让位。
  //
  // 只跟当前打开的会话：观察泵是会话切片自己的（切走不卸），但订阅全局只留一条，
  // 快速 A→B 时 A 迟到的 hydrate 不能把订阅从 B 抢回去。
  if (
    useConversationStore.getState().currentConversationId === conversationId
  ) {
    const followCloud = !recovery.sidecarLive && recovery.unsynced.length === 0;
    syncConversationFollow(followCloud ? conversationId : null);
    // 进了这个对话 → 页内快照（recovery / InteractionStore）接管权威，跨对话的「等你」
    // 提醒交棒。这也是断线期间漏收 `ai_attention` resolved 的唯一兜底：没有跨对话挂起
    // 快照接口，不清就会永远亮着一盏假灯。
    clearAiAttentionForConversation(conversationId);
  }
  // Live pump already claimed (session abort set) — attach* is idempotent via
  // isGenerating; settle must not rejoin over it either. Cold hydrate sets
  // isGenerating from isStreaming overlay but leaves abort null until attach.
  if (getRuntime(conversationId).abort) {
    return useLocal ? "local" : "cloud";
  }
  if (useLocal) {
    projectUnsyncedTurns(conversationId, recovery.unsynced);
    // Paused local turns skip attach (no live buffer). Cloud pause writeback
    // omits turn_journal, so reinject display runs from the pause frame.
    if (recovery.pausedCount > 0) {
      projectPausedRuns(conversationId, recovery.pausedRuns ?? {});
    }
    // After unsynced project: seal any blank open/ghost assistants as「已中断」.
    settleOrphanEmptyAssistants(conversationId);
    if (recovery.sidecarLive && recovery.pausedCount === 0) {
      // 切会话不卸观察泵 — 无页级 signal。
      await attachSidecarTurn(conversationId);
    }
    return "local";
  }
  const last = getRuntime(conversationId).messages.at(-1);
  if (last) {
    const canAttach = recovery.cloudLive && recovery.pausedCount === 0;
    if (last.role === "user" && canAttach) {
      void attachOnOpen(conversationId);
    } else if (last.role === "assistant" && last.status === "running") {
      await settleCloudRunningAssistant(conversationId, recovery);
    } else {
      // Warm reopen may leave a mid-slice empty incomplete from a prior preempt.
      settleOrphanEmptyAssistants(conversationId);
    }
  }
  return "cloud";
}
