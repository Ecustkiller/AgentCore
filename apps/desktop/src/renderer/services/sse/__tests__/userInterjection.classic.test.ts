import { dispatchSSEEvent } from "@/services/sse/dispatch";
import {
  assistantProjectionId,
  getRuntime,
  useConversationStore,
} from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CID = "conv-interjection-classic";

function emitInterjection(
  status: string,
  extra?: { user_message_id?: string; content?: string },
): void {
  dispatchSSEEvent(
    {
      type: "user_interjection",
      timestamp: "",
      payload: {
        interjection_id: "inj-1",
        execution_id: "exec-classic-1",
        content: extra?.content ?? "改成用中文总结",
        status,
        ...(extra?.user_message_id
          ? { user_message_id: extra.user_message_id }
          : {}),
      },
    },
    { conversationId: CID, source: "server" },
  );
}

function startTurn(): void {
  dispatchSSEEvent(
    {
      type: "message_start",
      timestamp: "",
      payload: { message_id: "m1", conversation_id: CID },
    },
    { conversationId: CID, source: "server" },
  );
}

function currentSlot() {
  const assistant = getRuntime(CID).messages.find(
    (m) => m.role === "assistant",
  );
  if (!assistant) return undefined;
  return useExecutionStore.getState().byId[assistantProjectionId(assistant)];
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().setTurnPhase("streaming", CID);
});

afterEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
});

describe("user_interjection · 经典单聊（无 run_plan）", () => {
  it("插话落在助手槽上，received 被 injected 覆盖", () => {
    startTurn();
    emitInterjection("received");
    emitInterjection("injected");

    expect(currentSlot()?.userInterjections).toEqual([
      {
        interjectionId: "inj-1",
        executionId: "exec-classic-1",
        content: "改成用中文总结",
        status: "injected",
        note: null,
      },
    ]);
    const assistant = getRuntime(CID).messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.process).toEqual([
      { kind: "user_interjection", interjection_id: "inj-1" },
    ]);
  });

  it("received 不进时间线；injected 用已记下的用户行 id 放入一次", () => {
    startTurn();
    emitInterjection("received", { user_message_id: "u-steer" });
    expect(getRuntime(CID).messages.some((m) => m.role === "user")).toBe(
      false,
    );

    emitInterjection("injected");
    expect(
      getRuntime(CID).messages.filter((m) => m.role === "user"),
    ).toEqual([
      expect.objectContaining({
        id: "u-steer",
        content: "改成用中文总结",
      }),
    ]);

    emitInterjection("addressed");
    expect(
      getRuntime(CID).messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
  });

  it("升成排队时不放进时间线", () => {
    startTurn();
    emitInterjection("received", { user_message_id: "u-steer" });
    emitInterjection("queued");
    expect(getRuntime(CID).messages.some((m) => m.role === "user")).toBe(
      false,
    );
  });

  it("经典单聊无 plan 也不丢插话", () => {
    startTurn();
    emitInterjection("received");

    expect(currentSlot()?.plan).toBeNull();
    expect(currentSlot()?.userInterjections).toHaveLength(1);
  });
});
