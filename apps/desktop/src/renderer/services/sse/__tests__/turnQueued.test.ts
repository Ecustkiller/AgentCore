import { notifyInfo } from "@/lib/toast";
import { handleMessageStreamEvent } from "@/services/sse/handlers/messageStream";
import { useConversationStore } from "@/stores/conversation";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

const notifyInfoMock = vi.mocked(notifyInfo);
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

describe("turn_queued · live 对齐 fold（EPHEMERAL toast）", () => {
  it("呈现既有「已排队」toast（单条）", () => {
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
    expect(notifyInfoMock).toHaveBeenCalledWith("已排队，当前回合结束后处理");
  });

  it("多条排队时带位次", () => {
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
    expect(notifyInfoMock).toHaveBeenCalledWith(
      expect.stringContaining("第 2/3 条"),
    );
  });

  it("degraded_from=steer → 额外 toast 说明已改为排队", () => {
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
    expect(notifyInfoMock).toHaveBeenCalledWith("已排队，当前回合结束后处理");
    expect(notifyInfoMock).toHaveBeenCalledWith(
      "当前无法插入，已改为排队，将在本回合结束后发送",
    );
  });
});

describe("turn_steer_accepted · live toast", () => {
  it("呈现「已插入，下一工具步生效」", () => {
    handleMessageStreamEvent(
      {
        type: "turn_steer_accepted",
        timestamp: "",
        payload: {
          steer_id: "steer-1",
          conversation_id: CID,
          content: "改成中文",
          pending: 1,
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(notifyInfoMock).toHaveBeenCalledWith("已插入，下一工具步生效");
  });
});

describe("turn_queue_cancelled · 清排队 UI", () => {
  it("移除 store 项与乐观用户气泡", () => {
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
  it("turn_queued 轻态 → turn_queue_started 后消失；用户泡保留", () => {
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

  it("只清匹配 queue_id；message_start 不再猜出队", () => {
    useConversationStore.getState().addMessage(
      {
        id: "user-a",
        role: "user",
        content: "A",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    useConversationStore.getState().addMessage(
      {
        id: "user-b",
        role: "user",
        content: "B",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-a",
      conversationId: CID,
      messageId: "user-a",
      content: "A",
      position: 1,
      queueDepth: 2,
    });
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-b",
      conversationId: CID,
      messageId: "user-b",
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
