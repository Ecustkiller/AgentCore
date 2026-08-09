import { logEvent } from "@/lib/log";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import {
  beginTurnPreflight,
  enterTurnStreaming,
  useConversationStore,
} from "@/stores/conversation";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/log", () => ({
  logEvent: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  api: { post: vi.fn() },
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
}));

const CID = "conv-turn-phase-gate";
const logEventMock = vi.mocked(logEvent);

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: CID, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  logEventMock.mockReset();
});

describe("dispatchSSEEvent turn-phase gate logging", () => {
  it("logs sse.event_dropped when content_delta is rejected in stopping", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    useConversationStore.getState().stopGeneration();

    dispatchSSEEvent(
      {
        type: "content_delta",
        payload: { delta: "迟到正文" },
      } as never,
      { conversationId: CID, source: "server" },
    );

    expect(logEventMock).toHaveBeenCalledWith(
      "warn",
      "sse.event_dropped",
      expect.objectContaining({
        conversation_id: CID,
        event_type: "content_delta",
        turn_phase: "stopping",
        reason: "turn_phase_gate",
      }),
    );
  });

  it("does not drop-log when checkpoint_required is allowed in terminal", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    useConversationStore.getState().setTurnPhase("completed", CID);

    dispatchSSEEvent(
      {
        type: "checkpoint_required",
        payload: {
          checkpoint_id: "cp-gate",
          questions: [{ id: "q1", prompt: "拍板？" }],
        },
      } as never,
      { conversationId: CID, source: "server" },
    );

    expect(logEventMock).not.toHaveBeenCalledWith(
      "warn",
      "sse.event_dropped",
      expect.anything(),
    );
    expect(logEventMock).not.toHaveBeenCalledWith(
      "warn",
      "workspace_op.dropped",
      expect.anything(),
    );
  });
});
