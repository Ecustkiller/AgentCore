import { getConversations } from "@/hooks/useConversations";
import {
  installAccountStateIngress,
  resetAccountStateIngressForTests,
} from "@/services/accountStateIngress";
import { useAiAttentionStore } from "@/stores/aiAttention";
import {
  applyAiTurnActivitySnapshot,
  useAiTurnActivityStore,
} from "@/stores/aiTurnActivity";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cloudCb: ((frame: unknown) => void) | null = null;

vi.mock("@/services/fulfillStream", () => ({
  onFulfillFrame: (cb: (frame: unknown) => void) => {
    cloudCb = cb;
    return () => {
      cloudCb = null;
    };
  },
}));

vi.mock("@/hooks/useConversations", () => ({
  getConversations: vi.fn(() => []),
}));

const getConversationsMock = vi.mocked(getConversations);

function runningIds(): string[] {
  return [...useAiTurnActivityStore.getState().running];
}

describe("accountStateIngress ai_turn_activity", () => {
  beforeEach(() => {
    resetAccountStateIngressForTests();
    useAiTurnActivityStore.getState().clear();
    cloudCb = null;
    installAccountStateIngress();
  });

  afterEach(() => {
    resetAccountStateIngressForTests();
    useAiTurnActivityStore.getState().clear();
  });

  it("snapshot replace 整份 running", () => {
    cloudCb?.({
      type: "ai_turn_activity_snapshot",
      payload: { running: ["c1", "c2"] },
    });
    expect(runningIds()).toEqual(["c1", "c2"]);

    cloudCb?.({
      type: "ai_turn_activity_snapshot",
      payload: { running: ["c2"] },
    });
    expect(runningIds()).toEqual(["c2"]);
  });

  it("增量 running / done 进出集合", () => {
    applyAiTurnActivitySnapshot({ running: ["c1"] });
    cloudCb?.({
      type: "ai_turn_activity",
      payload: { conversation_id: "c2", state: "running" },
    });
    expect(runningIds()).toEqual(["c1", "c2"]);

    cloudCb?.({
      type: "ai_turn_activity",
      payload: { conversation_id: "c1", state: "done", reason: "completed" },
    });
    expect(runningIds()).toEqual(["c2"]);
    expect(useAiTurnActivityStore.getState().lastDone).toMatchObject({
      conversationId: "c1",
      reason: "completed",
    });
  });
});

describe("accountStateIngress turn_queue", () => {
  beforeEach(() => {
    resetAccountStateIngressForTests();
    useQueuedTurnsStore.setState({ byConversation: {} });
    useConversationStore.setState({ byId: {} });
    getConversationsMock.mockReturnValue([]);
    cloudCb = null;
    installAccountStateIngress();
  });

  afterEach(() => {
    resetAccountStateIngressForTests();
    useQueuedTurnsStore.setState({ byConversation: {} });
    useConversationStore.setState({ byId: {} });
    getConversationsMock.mockReturnValue([]);
  });

  function seedLocal(conversationId: string, queueId: string): void {
    useQueuedTurnsStore.getState().replaceConversation(conversationId, [
      {
        queueId,
        conversationId,
        content: "local",
        position: 1,
        queueDepth: 1,
      },
    ]);
  }

  function seedCloud(conversationId: string, queueId: string): void {
    useQueuedTurnsStore.getState().replaceConversation(conversationId, [
      {
        queueId,
        conversationId,
        content: "stale",
        position: 1,
        queueDepth: 1,
      },
    ]);
  }

  it("账号空表必达：重连假条掉", () => {
    seedCloud("c-stale", "q-stale");
    cloudCb?.({
      type: "turn_queue_account_snapshot",
      payload: { queues: [] },
    });
    expect(useQueuedTurnsStore.getState().list("c-stale")).toEqual([]);
  });

  it("账号整表 replace 云队", () => {
    seedCloud("c-old", "q-old");
    cloudCb?.({
      type: "turn_queue_account_snapshot",
      payload: {
        queues: [
          {
            conversation_id: "c-new",
            items: [{ queue_id: "q-new", content: "fresh", position: 1 }],
          },
        ],
      },
    });
    expect(useQueuedTurnsStore.getState().list("c-old")).toEqual([]);
    expect(useQueuedTurnsStore.getState().list("c-new")).toEqual([
      expect.objectContaining({ queueId: "q-new", content: "fresh" }),
    ]);
  });

  it("缺 queues / 非数组不清表", () => {
    seedCloud("c1", "q1");
    cloudCb?.({ type: "turn_queue_account_snapshot", payload: null });
    cloudCb?.({ type: "turn_queue_account_snapshot", payload: {} });
    cloudCb?.({
      type: "turn_queue_account_snapshot",
      payload: { queues: "nope" },
    });
    expect(useQueuedTurnsStore.getState().list("c1")).toHaveLength(1);
  });

  it("sidecar / 本地容器 key 不被抹", () => {
    seedLocal("c-side", "q-side");
    seedLocal("c-root", "q-root");
    seedCloud("c-cloud", "q-cloud");
    useConversationStore.setState({
      byId: {
        "c-side": { ...EMPTY_RUNTIME, executionVia: "sidecar" },
      },
    });
    getConversationsMock.mockReturnValue([
      {
        id: "c-root",
        title: "local",
        updatedAt: "2020-01-01T00:00:00.000Z",
        messageCount: 0,
        lastMessagePreview: null,
        localContainerRootId: "root-1",
      },
    ]);

    cloudCb?.({
      type: "turn_queue_account_snapshot",
      payload: { queues: [] },
    });
    expect(useQueuedTurnsStore.getState().list("c-side")).toHaveLength(1);
    expect(useQueuedTurnsStore.getState().list("c-root")).toHaveLength(1);
    expect(useQueuedTurnsStore.getState().list("c-cloud")).toEqual([]);
  });

  it("增量空 items 仍清一条，不整表清空", () => {
    seedCloud("c1", "q1");
    seedCloud("c2", "q2");
    cloudCb?.({
      type: "turn_queue_snapshot",
      payload: { conversation_id: "c1", items: [] },
    });
    expect(useQueuedTurnsStore.getState().list("c1")).toEqual([]);
    expect(useQueuedTurnsStore.getState().list("c2")).toHaveLength(1);
  });

  it("增量缺字段 / 非数组不清任何条", () => {
    seedCloud("c1", "q1");
    cloudCb?.({ type: "turn_queue_snapshot", payload: { items: [] } });
    cloudCb?.({
      type: "turn_queue_snapshot",
      payload: { conversation_id: "c1", items: "nope" },
    });
    expect(useQueuedTurnsStore.getState().list("c1")).toHaveLength(1);
  });
});

describe("accountStateIngress ai_attention", () => {
  beforeEach(() => {
    resetAccountStateIngressForTests();
    useAiAttentionStore.setState({ entries: [] });
    cloudCb = null;
    installAccountStateIngress();
  });

  afterEach(() => {
    resetAccountStateIngressForTests();
    useAiAttentionStore.setState({ entries: [] });
  });

  it("snapshot replace 整表；空表灭假灯", () => {
    useAiAttentionStore.setState({
      entries: [
        {
          interactionId: "stale",
          conversationId: "c-stale",
          turnId: "t",
          kind: "approval",
          title: "假灯",
        },
      ],
    });
    cloudCb?.({
      type: "ai_attention_snapshot",
      payload: { entries: [] },
    });
    expect(useAiAttentionStore.getState().entries).toEqual([]);

    cloudCb?.({
      type: "ai_attention_snapshot",
      payload: {
        entries: [
          {
            conversation_id: "c1",
            turn_id: "t1",
            interaction_id: "i1",
            kind: "approval",
            title: "需要授权：终端",
          },
        ],
      },
    });
    expect(useAiAttentionStore.getState().entries).toEqual([
      {
        interactionId: "i1",
        conversationId: "c1",
        turnId: "t1",
        kind: "approval",
        title: "需要授权：终端",
      },
    ]);
  });

  it("缺 entries / 非数组不清表", () => {
    useAiAttentionStore.setState({
      entries: [
        {
          interactionId: "keep",
          conversationId: "c1",
          turnId: "t",
          kind: "approval",
          title: "留着",
        },
      ],
    });
    cloudCb?.({ type: "ai_attention_snapshot", payload: null });
    cloudCb?.({ type: "ai_attention_snapshot", payload: {} });
    cloudCb?.({
      type: "ai_attention_snapshot",
      payload: { entries: "nope" },
    });
    expect(useAiAttentionStore.getState().entries).toHaveLength(1);
  });

  it("增量 required / resolved 进出集合", () => {
    cloudCb?.({
      type: "ai_attention",
      payload: {
        state: "required",
        conversation_id: "c1",
        turn_id: "t1",
        interaction_id: "i1",
        kind: "approval",
        title: "需要授权：终端",
      },
    });
    expect(useAiAttentionStore.getState().entries).toHaveLength(1);

    cloudCb?.({
      type: "ai_attention",
      payload: {
        state: "resolved",
        conversation_id: "c1",
        turn_id: "t1",
        interaction_id: "i1",
        kind: "approval",
        title: "需要授权：终端",
      },
    });
    expect(useAiAttentionStore.getState().entries).toEqual([]);
  });
});
