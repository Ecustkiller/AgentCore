import { flushPendingContent } from "@/services/sse/contentBuffer";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import type { SidecarEventPush } from "@shared/sidecar-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimSidecarTurnSink,
  installSidecarEventPump,
  resetSidecarEventPumpForTests,
} from "../sidecarEventPump";
import {
  installSidecarHarvestClaim,
  resetSidecarHarvestClaimForTests,
} from "../sidecarHarvestClaim";
import { resetSidecarRoutingForTests } from "../sidecarRouting";
import {
  beginLocalConversationStream,
  resetStreamOwnershipForTests,
} from "../turns/streamOwnership";

const CID = "c-harvest-claim";

type EventCb = (push: SidecarEventPush) => void;

let onEventCb: EventCb | null;

function push(
  conversationId: string,
  turnId: string,
  type: string,
  payload: Record<string, unknown> = {},
): void {
  onEventCb?.({
    conversationId,
    turnId,
    event: {
      type,
      timestamp: "t",
      payload,
    },
  });
}

beforeEach(() => {
  resetSidecarHarvestClaimForTests();
  resetSidecarEventPumpForTests();
  resetStreamOwnershipForTests();
  resetSidecarRoutingForTests();
  onEventCb = null;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("window", {
    sidecarApi: {
      onEvent: (cb: EventCb) => {
        onEventCb = cb;
        return () => {
          if (onEventCb === cb) onEventCb = null;
        };
      },
    },
  });
  useConversationStore.setState({
    currentConversationId: CID,
    byId: {
      [CID]: {
        ...EMPTY_RUNTIME,
        messages: [
          {
            id: "u1",
            role: "user",
            content: "先派团队",
            createdAt: "2026-01-01T00:00:00Z",
            executionId: null,
            isStreaming: false,
          },
          {
            id: "a1",
            role: "assistant",
            content: "已派发",
            createdAt: "2026-01-01T00:00:01Z",
            executionId: null,
            isStreaming: false,
            serverMessageId: "srv-ceo",
          },
        ],
        turnPhase: "completed",
      },
    },
    sliceLruOrder: [CID],
    pendingFocus: null,
  });
  installSidecarEventPump();
  installSidecarHarvestClaim();
});

afterEach(() => {
  resetSidecarHarvestClaimForTests();
  resetSidecarEventPumpForTests();
  resetStreamOwnershipForTests();
  resetSidecarRoutingForTests();
});

describe("sidecarHarvestClaim 认领自发 turnId", () => {
  it("认领未占用会话的新 turnId 并折进助手泡", () => {
    push(CID, "turn-harvest", "message_start", {
      message_id: "srv-harvest",
      trace_id: "tr-h",
    });
    push(CID, "turn-harvest", "content_delta", { delta: "综述来了" });
    flushPendingContent(CID);

    const assistants = getRuntime(CID).messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    const live = assistants.at(-1);
    expect(live?.serverMessageId).toBe("srv-harvest");
    expect(live?.isStreaming).toBe(true);
    expect(live?.content).toContain("综述来了");
    expect(getRuntime(CID).isGenerating).toBe(true);
  });

  it("本机流占用且回合仍在生成时不认领、不驱逐活回合 sink", () => {
    useConversationStore.getState().setTurnPhase("streaming", CID);
    useConversationStore.setState((s) => {
      const rt = s.byId[CID];
      if (!rt) return s;
      return {
        byId: {
          ...s.byId,
          [CID]: {
            ...rt,
            messages: rt.messages.map((m) =>
              m.id === "a1" ? { ...m, isStreaming: true } : m,
            ),
          },
        },
      };
    });
    const live = vi.fn();
    const revoked = vi.fn();
    claimSidecarTurnSink(CID, "turn-live", live, { onRevoked: revoked });
    const release = beginLocalConversationStream(CID);

    push(CID, "turn-harvest", "message_start", {
      message_id: "srv-harvest",
    });
    push(CID, "turn-harvest", "content_delta", { delta: "不该进活回合" });

    expect(revoked).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    const assistants = getRuntime(CID).messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].serverMessageId).toBe("srv-ceo");
    release();
  });

  it("本机流未放但回合已终态时仍认领（CEO end_turn 后 harvest 热路径）", () => {
    const live = vi.fn();
    const revoked = vi.fn();
    claimSidecarTurnSink(CID, "turn-live", live, { onRevoked: revoked });
    const release = beginLocalConversationStream(CID);

    push(CID, "turn-harvest", "message_start", {
      message_id: "srv-harvest",
      trace_id: "tr-h",
    });
    push(CID, "turn-harvest", "content_delta", { delta: "综述来了" });
    flushPendingContent(CID);

    expect(revoked).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    const assistants = getRuntime(CID).messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    const harvest = assistants.at(-1);
    expect(harvest?.serverMessageId).toBe("srv-harvest");
    expect(harvest?.content).toContain("综述来了");
    release();
  });
});
