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
import { getRuntime } from "@/stores/conversation";
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
