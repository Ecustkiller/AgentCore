import { resumeDeferredCardCopy } from "@/lib/resumeDeferred";
import { notifyError, notifyInfo } from "@/lib/toast";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import { handleMessageStreamEvent } from "@/services/sse/handlers/messageStream";
import { useConversationStore } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

const notifyInfoMock = vi.mocked(notifyInfo);
const notifyErrorMock = vi.mocked(notifyError);
const CID = "conv-resume-deferred";
const MID = "msg-deferred-1";
const IX_ID = "cp-deferred-1";

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useInteractionStore.getState().clear();
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().setTurnPhase("streaming", CID);
  useInteractionStore.getState().upsertRequired({
    kind: "plan_review",
    conversationId: CID,
    messageId: MID,
    payload: {
      checkpoint_id: IX_ID,
      conversation_id: CID,
      steps: [],
      pending: [],
    },
  });
  useInteractionStore.getState().beginSubmit(IX_ID);
});

afterEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useInteractionStore.getState().clear();
});

describe("resume_deferred · live SSE（非 StreamError）", () => {
  it("stamps InteractionStore + keeps submitting；不 toast 收尾文案", () => {
    const handled = handleMessageStreamEvent(
      {
        type: "resume_deferred",
        timestamp: "",
        payload: {
          message_id: MID,
          conversation_id: CID,
          busy_reason: "live_turn",
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(handled).toBe(true);

    const entry = useInteractionStore.getState().byId.get(IX_ID);
    expect(entry?.status).toBe("submitting");
    expect(entry?.resumeDeferred).toEqual({ busyReason: "live_turn" });
    expect(notifyInfoMock).not.toHaveBeenCalled();
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it("wrap_up busy_reason 文案略不同；仍非错误路径", () => {
    handleMessageStreamEvent(
      {
        type: "resume_deferred",
        timestamp: "",
        payload: {
          message_id: MID,
          conversation_id: CID,
          busy_reason: "wrap_up",
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(
      useInteractionStore.getState().byId.get(IX_ID)?.resumeDeferred,
    ).toEqual({ busyReason: "wrap_up" });
    expect(resumeDeferredCardCopy("wrap_up")).toContain("放行已记下");
    expect(resumeDeferredCardCopy("wrap_up")).toContain("收尾完成");
    expect(resumeDeferredCardCopy("wrap_up")).not.toContain("回合收尾尚未完成");
    expect(resumeDeferredCardCopy("live_turn")).toContain("当前回合结束后");
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it("dispatchSSEEvent 消费 resume_deferred（不 assertNever / 不当 StreamError）", () => {
    expect(() =>
      dispatchSSEEvent(
        {
          type: "resume_deferred",
          timestamp: "",
          payload: {
            message_id: MID,
            conversation_id: CID,
            busy_reason: "live_turn",
          },
        },
        { conversationId: CID, source: "server" },
      ),
    ).not.toThrow();
    expect(
      useInteractionStore.getState().byId.get(IX_ID)?.resumeDeferred
        ?.busyReason,
    ).toBe("live_turn");
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it("sidecar 通道 source 同样 stamp markResumeDeferred（与云端同一套 handler）", () => {
    dispatchSSEEvent(
      {
        type: "resume_deferred",
        timestamp: "",
        payload: {
          message_id: MID,
          conversation_id: CID,
          busy_reason: "wrap_up",
        },
      },
      { conversationId: CID, source: "sidecar" },
    );
    expect(
      useInteractionStore.getState().byId.get(IX_ID)?.resumeDeferred,
    ).toEqual({ busyReason: "wrap_up" });
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });
});
