import { ApiError, api } from "@/services/api";
import {
  cancelQueuedTurn,
  clearQueuedTurnLocally,
} from "@/services/turns/cancelQueuedTurn";
import { useConversationStore } from "@/stores/conversation";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn() },
  };
});

const post = vi.mocked(api.post);
const CID = "conv-cancel-q";

/** Happy path：排队期无用户泡，仅条。 */
function seedQueuedBarOnly() {
  useConversationStore.getState().switchConversation(CID);
  useQueuedTurnsStore.getState().upsert({
    queueId: "q1",
    conversationId: CID,
    content: "queued",
    position: 1,
    queueDepth: 1,
  });
}

/** 防御：出队插泡后仍挂 messageId 时取消可顺带删泡。 */
function seedQueuedWithBubble() {
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().addMessage(
    {
      id: "user-q",
      role: "user",
      content: "queued",
      createdAt: new Date().toISOString(),
      executionId: null,
      isStreaming: false,
    },
    CID,
  );
  useQueuedTurnsStore.getState().upsert({
    queueId: "q1",
    conversationId: CID,
    messageId: "user-q",
    content: "queued",
    position: 1,
    queueDepth: 1,
  });
}

beforeEach(() => {
  post.mockReset();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useQueuedTurnsStore.setState({ byConversation: {} });
});

describe("clearQueuedTurnLocally", () => {
  it("无泡：只清条（幂等）", () => {
    seedQueuedBarOnly();
    expect(clearQueuedTurnLocally(CID, "q1")?.queueId).toBe("q1");
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    expect(clearQueuedTurnLocally(CID, "q1")).toBeNull();
  });

  it("有 messageId：清条并删对应泡", () => {
    seedQueuedWithBubble();
    expect(clearQueuedTurnLocally(CID, "q1")?.messageId).toBe("user-q");
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    expect(
      useConversationStore
        .getState()
        .byId[CID]?.messages.find((m) => m.id === "user-q"),
    ).toBeUndefined();
  });
});

describe("cancelQueuedTurn", () => {
  it("HTTP 成功 → 立刻本地清条（无泡）", async () => {
    seedQueuedBarOnly();
    post.mockResolvedValueOnce({});
    await cancelQueuedTurn(CID, "q1");
    expect(post).toHaveBeenCalledWith(
      `/v1/conversations/${CID}/queued-turns/q1/cancel`,
      {},
    );
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("404（已不在队）→ 同样本地清该项", async () => {
    seedQueuedBarOnly();
    post.mockRejectedValueOnce(new ApiError(404, "{}"));
    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBeUndefined();
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("其它错误 → 抛出且不清 UI", async () => {
    seedQueuedBarOnly();
    post.mockRejectedValueOnce(new ApiError(500, "{}"));
    await expect(cancelQueuedTurn(CID, "q1")).rejects.toBeInstanceOf(ApiError);
    expect(useQueuedTurnsStore.getState().list(CID)).toHaveLength(1);
  });
});
