/**
 * B5 orphan empty-bubble settle (1a69f9dc · 方案 A).
 */
import { useConversationStore } from "@/stores/conversation";
import { beforeEach, describe, expect, it } from "vitest";
import { settleOrphanEmptyAssistants } from "../turns/recovery";

const CID = "conv-orphan-empty";

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

describe("settleOrphanEmptyAssistants", () => {
  it("rewrites streaming empty assistant to interrupted", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "u1",
        role: "user",
        content: "q",
        createdAt: "2026-01-01T00:00:00Z",
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    store.addMessage(
      {
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: true,
        status: "running",
      },
      CID,
    );

    settleOrphanEmptyAssistants(CID);

    const a = useConversationStore
      .getState()
      .byId[CID].messages.find((m) => m.id === "a1");
    expect(a?.isStreaming).toBe(false);
    expect(a?.status).toBe("incomplete");
    expect(a?.finishReason).toBe("interrupted");
  });

  it("leaves cancelled empty alone (synthetic cancelled face)", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "a-cancel",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: false,
        status: "incomplete",
        finishReason: "cancelled",
      },
      CID,
    );

    settleOrphanEmptyAssistants(CID);

    const a = useConversationStore
      .getState()
      .byId[CID].messages.find((m) => m.id === "a-cancel");
    expect(a?.finishReason).toBe("cancelled");
  });

  it("does not touch assistants with body", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "a-body",
        role: "assistant",
        content: "partial answer",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: true,
        status: "running",
      },
      CID,
    );

    settleOrphanEmptyAssistants(CID);

    const a = useConversationStore
      .getState()
      .byId[CID].messages.find((m) => m.id === "a-body");
    expect(a?.isStreaming).toBe(true);
    expect(a?.finishReason).toBeUndefined();
  });
});
