import { sendAskReply } from "@/services/askReply";
import { submitInteraction } from "@/services/interactionSubmit";
import { sendTurn } from "@/services/turns";
import { sendMidFlightMessage } from "@/services/turns/midFlight";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/interactionSubmit", () => ({
  submitInteraction: vi.fn().mockResolvedValue("ok"),
}));
vi.mock("@/services/turns", () => ({
  sendTurn: vi.fn().mockResolvedValue({ unstartedRefusal: false }),
}));
vi.mock("@/services/turns/midFlight", () => ({
  sendMidFlightMessage: vi.fn().mockResolvedValue({
    kind: "received",
    interjectionId: "inj-1",
  }),
}));

const submitMock = vi.mocked(submitInteraction);
const sendTurnMock = vi.mocked(sendTurn);
const midMock = vi.mocked(sendMidFlightMessage);

beforeEach(() => {
  submitMock.mockClear();
  sendTurnMock.mockClear();
  midMock.mockClear();
  useConversationStore.setState({
    currentConversationId: "c1",
    byId: { c1: { ...EMPTY_RUNTIME, isGenerating: false } },
  });
});

describe("sendAskReply", () => {
  it("idle: new turn carries ask_id and does not settle on the client", async () => {
    const result = await sendAskReply({
      conversationId: "c1",
      askId: "ask1",
      text: "也要 PDF。",
    });
    expect(result).toBe("ok");
    expect(sendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "c1",
        content: "也要 PDF。",
        askId: "ask1",
      }),
    );
    expect(midMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("generating: interjection carries ask_id and does not settle on the client", async () => {
    useConversationStore.setState({
      currentConversationId: "c1",
      byId: { c1: { ...EMPTY_RUNTIME, isGenerating: true } },
    });
    const result = await sendAskReply({
      conversationId: "c1",
      askId: "ask1",
      text: "也要 PDF。",
    });
    expect(result).toBe("ok");
    expect(midMock).toHaveBeenCalledWith(
      "c1",
      "也要 PDF。",
      undefined,
      "steer",
      undefined,
      "ask1",
    );
    expect(sendTurnMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("generating: queued is accepted and does not settle", async () => {
    useConversationStore.setState({
      currentConversationId: "c1",
      byId: { c1: { ...EMPTY_RUNTIME, isGenerating: true } },
    });
    midMock.mockResolvedValueOnce({
      kind: "queued",
      position: 1,
      queueDepth: 1,
      queueId: "q1",
    });
    const result = await sendAskReply({
      conversationId: "c1",
      askId: "ask1",
      text: "也要 PDF。",
    });
    expect(result).toBe("queued");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("idle: unstartedRefusal does not settle", async () => {
    sendTurnMock.mockResolvedValueOnce({ unstartedRefusal: true });
    const result = await sendAskReply({
      conversationId: "c1",
      askId: "ask1",
      text: "也要 PDF。",
    });
    expect(result).toBe("send_failed");
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("idle: user-stop unstartedRefusal=false does not POST question_posted", async () => {
    sendTurnMock.mockResolvedValueOnce({ unstartedRefusal: false });
    const result = await sendAskReply({
      conversationId: "c1",
      askId: "ask1",
      text: "也要 PDF。",
    });
    expect(result).toBe("ok");
    expect(submitMock).not.toHaveBeenCalled();
  });
});
