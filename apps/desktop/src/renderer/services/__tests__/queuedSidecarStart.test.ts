import { resetSidecarEventPumpForTests } from "@/services/sidecarEventPump";
import { startQueuedSidecarTurn } from "@/services/streamConversationViaSidecar";
import { resetStreamOwnershipForTests } from "@/services/turns/streamOwnership";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import type { SidecarEventPush } from "@shared/sidecar-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CID = "conv-queue-start";

let onEventCb: ((push: SidecarEventPush) => void) | null = null;

beforeEach(() => {
  resetSidecarEventPumpForTests();
  resetStreamOwnershipForTests();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().setTurnPhase("completed", CID);
  onEventCb = null;
  vi.stubGlobal("window", {
    sidecarApi: {
      onEvent: (cb: (push: SidecarEventPush) => void) => {
        onEventCb = cb;
        return () => {
          if (onEventCb === cb) onEventCb = null;
        };
      },
      startTurn: vi.fn(async (req: { turnId: string }) => {
        expect(
          getRuntime(CID).messages.some((m) => m.role === "user"),
        ).toBe(false);
        onEventCb?.({
          conversationId: CID,
          turnId: req.turnId,
          event: {
            type: "turn_queue_started",
            timestamp: "",
            payload: {
              queue_id: "q1",
              conversation_id: CID,
              remaining_depth: 0,
              content: "好的",
              user_message_id: "u-queued",
            },
          },
        });
        return {
          turnId: req.turnId,
          messageId: "m-asst",
          content: "",
          reasoningContent: null,
          finishReason: "stop",
          model: "m",
          rounds: 1,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
          },
        };
      }),
      cancel: vi.fn(async () => {}),
    },
    outboxApi: {
      flushTurn: vi.fn(async () => ({ ok: false, error: "test" })),
    },
  });
});

afterEach(() => {
  resetSidecarEventPumpForTests();
  resetStreamOwnershipForTests();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  vi.unstubAllGlobals();
});

describe("startQueuedSidecarTurn", () => {
  it("上一回合已结束也能开跑，用户行等出队帧才出现", async () => {
    await startQueuedSidecarTurn({
      conversationId: CID,
      rootId: "r1",
      subpath: "",
      queueId: "q1",
      userMessageId: "u-queued",
      messageId: "m-asst",
      traceId: "a".repeat(32),
      userMessage: "好的",
    });

    const startTurn = vi.mocked(window.sidecarApi.startTurn);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CID,
        queueId: "q1",
        userMessageId: "u-queued",
        userMessage: "好的",
      }),
    );
    expect(
      getRuntime(CID).messages.filter((m) => m.role === "user"),
    ).toEqual([expect.objectContaining({ id: "u-queued", content: "好的" })]);
  });
});
