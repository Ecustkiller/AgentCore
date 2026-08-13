import { notifyInfo } from "@/lib/toast";
import { handleMessageStreamEvent } from "@/services/sse/handlers/messageStream";
import { reconcileQueuedTurns } from "@/services/turns/reconcileQueuedTurns";
import { useConversationStore } from "@/stores/conversation";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/services/turns/reconcileQueuedTurns", () => ({
  reconcileQueuedTurns: vi.fn(() => Promise.resolve()),
}));

const notifyInfoMock = vi.mocked(notifyInfo);
const reconcileMock = vi.mocked(reconcileQueuedTurns);
const CID = "conv-turn-queued";

beforeEach(() => {
  vi.clearAllMocks();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useQueuedTurnsStore.setState({ byConversation: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().setTurnPhase("streaming", CID);
});

afterEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useQueuedTurnsStore.setState({ byConversation: {} });
});

describe("turn_queued · live 对齐 fold（EPHEMERAL）", () => {
  it("普通排队不弹 toast（QueuedTurnsBar 承载）", () => {
    handleMessageStreamEvent(
      {
        type: "turn_queued",
        timestamp: "",
        payload: {
          queue_id: "q1",
          position: 1,
          queue_depth: 1,
          conversation_id: CID,
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(notifyInfoMock).not.toHaveBeenCalled();
  });

  it("条上缺 queue_id → 触发 GET 对账（升队 / 多端）", () => {
    handleMessageStreamEvent(
      {
        type: "turn_queued",
        timestamp: "",
        payload: {
          queue_id: "q-remote",
          position: 1,
          queue_depth: 1,
          conversation_id: CID,
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(reconcileMock).toHaveBeenCalledWith(CID);
  });

  it("条上已有 queue_id（本端 midFlight upsert）→ 不对账", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-local",
      conversationId: CID,
      content: "本端已写入",
      position: 1,
      queueDepth: 1,
    });
    handleMessageStreamEvent(
      {
        type: "turn_queued",
        timestamp: "",
        payload: {
          queue_id: "q-local",
          position: 1,
          queue_depth: 1,
          conversation_id: CID,
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("多条普通排队亦不弹 toast", () => {
    handleMessageStreamEvent(
      {
        type: "turn_queued",
        timestamp: "",
        payload: {
          queue_id: "q2",
          position: 2,
          queue_depth: 3,
          conversation_id: CID,
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(notifyInfoMock).not.toHaveBeenCalled();
  });

  it("degraded_from=steer → toast 说明已改为排队（禁伪装已插入）", () => {
    handleMessageStreamEvent(
      {
        type: "turn_queued",
        timestamp: "",
        payload: {
          queue_id: "q3",
          position: 1,
          queue_depth: 1,
          conversation_id: CID,
          degraded_from: "steer",
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(notifyInfoMock).toHaveBeenCalledWith(
      "当前无法插入，已改为排队，将在本回合结束后发送",
    );
  });
});

describe("turn_queue_cancelled · 清排队 UI", () => {
  it("无泡：只清条", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-cancel",
      conversationId: CID,
      content: "queued",
      position: 1,
      queueDepth: 1,
    });

    handleMessageStreamEvent(
      {
        type: "turn_queue_cancelled",
        timestamp: "",
        payload: { queue_id: "q-cancel", conversation_id: CID },
      },
      { conversationId: CID, source: "server" },
    );

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("有 messageId：清条并删对应泡", () => {
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
      queueId: "q-cancel",
      conversationId: CID,
      messageId: "user-q",
      content: "queued",
      position: 1,
      queueDepth: 1,
    });

    handleMessageStreamEvent(
      {
        type: "turn_queue_cancelled",
        timestamp: "",
        payload: { queue_id: "q-cancel", conversation_id: CID },
      },
      { conversationId: CID, source: "server" },
    );

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    expect(
      useConversationStore
        .getState()
        .byId[CID]?.messages.find((m) => m.id === "user-q"),
    ).toBeUndefined();
  });

  it("本地已清后 SSE 幂等 no-op", () => {
    handleMessageStreamEvent(
      {
        type: "turn_queue_cancelled",
        timestamp: "",
        payload: { queue_id: "missing", conversation_id: CID },
      },
      { conversationId: CID, source: "server" },
    );
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });
});

describe("turn_queue_started · 契约出队清轻态", () => {
  it("turn_queued 条 → turn_queue_started 后消失；已有用户泡则保留", () => {
    useConversationStore.getState().addMessage(
      {
        id: "user-drain",
        role: "user",
        content: "开跑这条",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-start",
      conversationId: CID,
      messageId: "user-drain",
      content: "开跑这条",
      position: 1,
      queueDepth: 1,
    });

    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-start",
          conversation_id: CID,
          remaining_depth: 0,
        },
      },
      { conversationId: CID, source: "server" },
    );

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    expect(
      useConversationStore
        .getState()
        .byId[CID]?.messages.find((m) => m.id === "user-drain"),
    ).toMatchObject({ role: "user", content: "开跑这条" });
  });

  it("无泡条：started 只清条", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-bar",
      conversationId: CID,
      content: "仅条",
      position: 1,
      queueDepth: 1,
    });

    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-bar",
          conversation_id: CID,
          remaining_depth: 0,
        },
      },
      { conversationId: CID, source: "server" },
    );

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    expect(
      useConversationStore.getState().byId[CID]?.messages ?? [],
    ).toHaveLength(0);
  });

  it("只清匹配 queue_id；message_start 不再猜出队", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-a",
      conversationId: CID,
      content: "A",
      position: 1,
      queueDepth: 2,
    });
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-b",
      conversationId: CID,
      content: "B",
      position: 2,
      queueDepth: 2,
    });

    // 仅 message_start：不得清轻态（已退役猜出队启发式）
    handleMessageStreamEvent(
      {
        type: "message_start",
        timestamp: "",
        payload: { message_id: "asst-new" },
      },
      { conversationId: CID, source: "server" },
    );
    expect(useQueuedTurnsStore.getState().list(CID)).toHaveLength(2);

    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-a",
          conversation_id: CID,
          remaining_depth: 1,
        },
      },
      { conversationId: CID, source: "server" },
    );
    const left = useQueuedTurnsStore.getState().list(CID);
    expect(left).toHaveLength(1);
    expect(left[0]?.queueId).toBe("q-b");
  });

  it("缺项时幂等 no-op", () => {
    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "ghost",
          conversation_id: CID,
          remaining_depth: 0,
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });
});

/**
 * 队里少一项，剩下几条的「第 N/M」就过期了——出队 / 取消可能来自另一端，本端算不出新序，
 * 只能拉 GET 权威（禁轮询：只在信号后拉；空队则一趟都不发）。
 */
describe("少一项后的重排（云对话多端同权 B2 · 验收 5）", () => {
  function queueTwo(): void {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-a",
      conversationId: CID,
      content: "A",
      position: 1,
      queueDepth: 2,
    });
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-b",
      conversationId: CID,
      content: "B",
      position: 2,
      queueDepth: 2,
    });
  }

  it("另一端取消中间一项 → 剩余条拉 GET 重排", () => {
    queueTwo();
    handleMessageStreamEvent(
      {
        type: "turn_queue_cancelled",
        timestamp: "",
        payload: { queue_id: "q-a", conversation_id: CID },
      },
      { conversationId: CID, source: "server" },
    );
    expect(reconcileMock).toHaveBeenCalledWith(CID);
  });

  it("出队开跑后仍有剩余 → 同样重排", () => {
    queueTwo();
    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-a",
          conversation_id: CID,
          remaining_depth: 1,
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(reconcileMock).toHaveBeenCalledWith(CID);
  });

  it("清空到空队 → 无序可重排，不发请求", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-only",
      conversationId: CID,
      content: "唯一一条",
      position: 1,
      queueDepth: 1,
    });
    handleMessageStreamEvent(
      {
        type: "turn_queue_cancelled",
        timestamp: "",
        payload: { queue_id: "q-only", conversation_id: CID },
      },
      { conversationId: CID, source: "server" },
    );
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
