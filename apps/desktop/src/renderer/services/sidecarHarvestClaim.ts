/**
 * Sidecar 自发回合（harvest）认领：未占用的同会话新 turnId →
 * {@link claimSidecarTurnSink} + 现有 {@link dispatchSSEEvent}。
 *
 * 活回合（streaming/stopping）不 claim；终态后 startTurn 尚未释放本机流仍认领。
 * 写回 softRefresh 仍是兜底。
 * 禁止扫自由文、禁止新造 SSE。
 */
import {
  type SidecarTurnClaim,
  claimSidecarTurnSink,
  setUnclaimedSidecarTurnHandler,
} from "@/services/sidecarEventPump";
import {
  clearActiveSidecarTurn,
  getLastSidecarTarget,
  setActiveSidecarTurn,
} from "@/services/sidecarRouting";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import {
  getTurnPhase,
  isTerminalPhase,
  useConversationStore,
} from "@/stores/conversation";
import type { SSEEvent } from "@/types/events";
import type { SidecarEventPush } from "@shared/sidecar-contract";
import {
  beginLocalConversationStream,
  hasLocalConversationStream,
} from "./turns/streamOwnership";

type HarvestClaim = {
  claim: SidecarTurnClaim;
  releaseLocal: () => void;
};

const claims = new Map<string, HarvestClaim>();

function claimKey(conversationId: string, turnId: string): string {
  return `${conversationId}\0${turnId}`;
}

function isTerminalEvent(event: SidecarEventPush["event"]): boolean {
  return event.type === "message_end" || event.type === "error";
}

function teardown(conversationId: string, turnId: string): void {
  const key = claimKey(conversationId, turnId);
  const held = claims.get(key);
  if (!held) return;
  claims.delete(key);
  held.claim.release();
  held.releaseLocal();
  clearActiveSidecarTurn(conversationId, turnId);
}

/**
 * 未认领的同会话 turnId：claim 并准备接收本帧。
 * 返回 true 后由泵把当前 push 投进新 sink（避免本模块与泵各折一次）。
 */
export function tryClaimUnownedSidecarTurn(push: SidecarEventPush): boolean {
  const { conversationId, turnId } = push;
  if (!conversationId || !turnId) return false;
  if (claims.has(claimKey(conversationId, turnId))) return true;
  // 活回合（streaming/stopping）不抢。CEO 已 message_end、phase 已终态、
  // 但 startTurn finally 还没释放本机流——这是 harvest 热路径，必须认领，
  // 否则丢掉 message_start，后续 delta 会写回「人已派出」旧泡。
  if (hasLocalConversationStream(conversationId)) {
    const phase = getTurnPhase(conversationId);
    if (phase !== "idle" && phase !== "preflight" && !isTerminalPhase(phase)) {
      return false;
    }
  }

  const releaseLocal = beginLocalConversationStream(conversationId);
  const store = useConversationStore.getState();
  const phase = getTurnPhase(conversationId);
  if (phase === "idle" || phase === "preflight" || isTerminalPhase(phase)) {
    store.setTurnPhase("streaming", conversationId);
  }
  store.setGenerating(true, conversationId);

  const target = getLastSidecarTarget(conversationId);
  if (target) {
    setActiveSidecarTurn(conversationId, target.rootId, target.subpath, turnId);
  }

  const claim = claimSidecarTurnSink(
    conversationId,
    turnId,
    (next) => {
      dispatchSSEEvent(next.event as SSEEvent, {
        conversationId,
        source: "sidecar",
      });
      if (isTerminalEvent(next.event)) {
        teardown(conversationId, turnId);
      }
    },
    {
      onRevoked: () => {
        teardown(conversationId, turnId);
      },
    },
  );
  claims.set(claimKey(conversationId, turnId), { claim, releaseLocal });
  return true;
}

/** App 生命周期注册未认领 turn 兜底；幂等。 */
export function installSidecarHarvestClaim(): void {
  setUnclaimedSidecarTurnHandler(tryClaimUnownedSidecarTurn);
}

/** 测试隔离。 */
export function resetSidecarHarvestClaimForTests(): void {
  for (const [key, held] of claims) {
    const [conversationId, turnId] = key.split("\0");
    held.claim.release();
    held.releaseLocal();
    if (conversationId && turnId) {
      clearActiveSidecarTurn(conversationId, turnId);
    }
  }
  claims.clear();
  setUnclaimedSidecarTurnHandler(null);
}
