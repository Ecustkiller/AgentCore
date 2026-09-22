import { notifyInfo } from "@/lib/toast";
import { handleMessageStreamEvent } from "@/services/sse/handlers/messageStream";
import { handleMetaEvent } from "@/services/sse/handlers/meta";
import {
  clearQueuedTurnLocally,
  resetPromotedUserRowsForTests,
} from "@/services/turns/queuedTurnLocal";
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
  resetPromotedUserRowsForTests();
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

  it("条上缺 queue_id 也不回头拉：整队快照走设备通道自己会到", () => {
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
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
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

  it("无泡条：started 按 user_message_id 插用户行再清条", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-bar",
      conversationId: CID,
      content: "条上旧文",
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
          content: "帧正文",
          user_message_id: "u-frame",
        },
      },
      { conversationId: CID, source: "server" },
    );

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: "u-frame", content: "帧正文" });
  });

  it("空快照 replaceConversation([]) 清条后 started 带 content 仍插泡", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-cleared",
      conversationId: CID,
      content: "条上旧文",
      position: 1,
      queueDepth: 1,
    });
    useQueuedTurnsStore.getState().replaceConversation(CID, []);

    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-cleared",
          conversation_id: CID,
          remaining_depth: 0,
          content: "出队正文",
          user_message_id: "u-cleared",
        },
      },
      { conversationId: CID, source: "server" },
    );

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user" && m.content === "出队正文");
    expect(users).toEqual([expect.objectContaining({ id: "u-cleared" })]);
  });

  it("同 queue_id 再折 started 不双插", () => {
    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-exist",
          conversation_id: CID,
          remaining_depth: 0,
          content: "已有",
          user_message_id: "u-exist",
        },
      },
      { conversationId: CID, source: "server" },
    );
    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-exist",
          conversation_id: CID,
          remaining_depth: 0,
          content: "已有",
          user_message_id: "u-exist",
        },
      },
      { conversationId: CID, source: "server" },
    );

    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user" && m.content === "已有");
    expect(users).toHaveLength(1);
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

  it("点名的 message_start 按 id 插入并只摘掉该条，尾部仍是助手", () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-a",
      conversationId: CID,
      content: "好的",
      position: 1,
      queueDepth: 2,
      messageId: "u-a",
    });
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-b",
      conversationId: CID,
      content: "下一条",
      position: 2,
      queueDepth: 2,
      messageId: "u-b",
    });

    const named = {
      type: "message_start" as const,
      timestamp: "",
      payload: {
        message_id: "asst-1",
        conversation_id: CID,
        user_message_id: "u-a",
        content: "好的",
      },
    };
    handleMessageStreamEvent(named, { conversationId: CID, source: "server" });

    const messages = useConversationStore.getState().byId[CID]?.messages ?? [];
    const users = messages.filter((m) => m.role === "user" && m.id === "u-a");
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toBe("好的");
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(messages.at(-1)?.serverMessageId).toBe("asst-1");
    expect(useQueuedTurnsStore.getState().list(CID).map((e) => e.queueId)).toEqual([
      "q-b",
    ]);

    handleMessageStreamEvent(named, { conversationId: CID, source: "server" });
    const again = useConversationStore.getState().byId[CID]?.messages ?? [];
    expect(again.filter((m) => m.role === "user" && m.id === "u-a")).toHaveLength(1);
    expect(useQueuedTurnsStore.getState().list(CID)).toHaveLength(1);
  });

  it("没有稳定用户行 id 时不插临时泡；有 id 才插入", () => {
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
    expect(
      useConversationStore.getState().byId[CID]?.messages ?? [],
    ).toHaveLength(0);

    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "ghost",
          conversation_id: CID,
          remaining_depth: 0,
          content: "帧上有正文",
          user_message_id: "u-ghost",
        },
      },
      { conversationId: CID, source: "server" },
    );
    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user" && m.content === "帧上有正文");
    expect(users).toEqual([expect.objectContaining({ id: "u-ghost" })]);
  });

  it("已有 user1：started + turn_saved 不改 user1 的 id", () => {
    useConversationStore.getState().addMessage(
      {
        id: "user1",
        role: "user",
        content: "你有什么功能",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );

    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-next",
          conversation_id: CID,
          remaining_depth: 0,
          content: "第二问",
          user_message_id: "u-server",
        },
      },
      { conversationId: CID, source: "server" },
    );
    handleMetaEvent(
      {
        type: "turn_saved",
        timestamp: "",
        payload: { user_message_id: "u-server" },
      },
      { conversationId: CID, source: "server" },
    );

    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ id: "user1", content: "你有什么功能" });
    expect(users[1]).toMatchObject({ id: "u-server", content: "第二问" });
  });

  it("无排队入场泡时 turn_saved 仍 reconcile 最后一条 user", () => {
    useConversationStore.getState().addMessage(
      {
        id: "opt-idle",
        role: "user",
        content: "空闲发送",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    handleMetaEvent(
      {
        type: "turn_saved",
        timestamp: "",
        payload: { user_message_id: "u-idle" },
      },
      { conversationId: CID, source: "server" },
    );
    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe("u-idle");
  });

  it("窗里已有同一用户行：started 只清条不再插一条", () => {
    useConversationStore.getState().addMessage(
      {
        id: "u-catch",
        role: "user",
        content: "窗里已有",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-catch",
      conversationId: CID,
      content: "条上",
      messageId: "u-catch",
      position: 1,
      queueDepth: 1,
    });
    handleMessageStreamEvent(
      {
        type: "turn_queue_started",
        timestamp: "",
        payload: {
          queue_id: "q-catch",
          conversation_id: CID,
          remaining_depth: 0,
          content: "窗里已有",
          user_message_id: "u-catch",
        },
      },
      { conversationId: CID, source: "server" },
    );
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user");
    expect(users).toEqual([expect.objectContaining({ id: "u-catch" })]);
  });
});

describe("turn_saved · 排队条记下服务端用户行 id", () => {
  const SERVER_ID = "u-server-bind";

  function enqueueUnbound(): void {
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-bind",
      conversationId: CID,
      content: "排队句",
      position: 1,
      queueDepth: 1,
    });
  }

  it("未绑定的排队条收到 turn_saved 后记下服务端 id，时间线仍没有这一行", () => {
    useConversationStore.getState().addMessage(
      {
        id: "user1",
        role: "user",
        content: "上一问",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    enqueueUnbound();
    handleMetaEvent(
      {
        type: "turn_saved",
        timestamp: "",
        payload: { user_message_id: SERVER_ID },
      },
      { conversationId: CID, source: "server" },
    );

    const users = (
      useConversationStore.getState().byId[CID]?.messages ?? []
    ).filter((m) => m.role === "user");
    expect(users).toEqual([expect.objectContaining({ id: "user1" })]);
    expect(useQueuedTurnsStore.getState().list(CID)[0]?.messageId).toBe(
      SERVER_ID,
    );
  });

  it("记下之后取消按服务端 id 删行", () => {
    enqueueUnbound();
    handleMetaEvent(
      {
        type: "turn_saved",
        timestamp: "",
        payload: { user_message_id: SERVER_ID },
      },
      { conversationId: CID, source: "server" },
    );
    useConversationStore.getState().addMessage(
      {
        id: SERVER_ID,
        role: "user",
        content: "排队句",
        createdAt: new Date().toISOString(),
        executionId: null,
        isStreaming: false,
      },
      CID,
    );

    expect(clearQueuedTurnLocally(CID, "q-bind")?.messageId).toBe(SERVER_ID);
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    const messages = useConversationStore.getState().byId[CID]?.messages ?? [];
    expect(messages.find((m) => m.id === SERVER_ID)).toBeUndefined();
  });
});

/**
 * 队里少一项，剩下几条的「第 N/M」就过期了——但本端不去拉：服务端每次改队都把该
 * 会话整队快照推给这个账号的每台在线设备（`turn_queue_snapshot`），序号在那边就已算好。
 * 这条流只负责把出队 / 取消那一条即时摘掉，别让它在快照到达前还挂着。
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

  it("另一端取消中间一项 → 本端只摘掉那条，不发请求", () => {
    queueTwo();
    handleMessageStreamEvent(
      {
        type: "turn_queue_cancelled",
        timestamp: "",
        payload: { queue_id: "q-a", conversation_id: CID },
      },
      { conversationId: CID, source: "server" },
    );
    const left = useQueuedTurnsStore.getState().list(CID);
    expect(left.map((e) => e.queueId)).toEqual(["q-b"]);
  });

  it("出队开跑后仍有剩余 → 同样只摘掉出队那条", () => {
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
    const left = useQueuedTurnsStore.getState().list(CID);
    expect(left.map((e) => e.queueId)).toEqual(["q-b"]);
  });
});
