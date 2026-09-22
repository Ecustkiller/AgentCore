import {
  installAccountStateIngress,
  resetAccountStateIngressForTests,
} from "@/services/accountStateIngress";
import { ApiError, api } from "@/services/api";
import {
  clearActiveSidecarTurn,
  resetSidecarRoutingForTests,
  setActiveSidecarTurn,
} from "@/services/sidecarRouting";
import {
  cancelQueuedTurn,
  clearQueuedTurnLocally,
  editQueuedTurn,
} from "@/services/turns/cancelQueuedTurn";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    api: { ...actual.api, post: vi.fn() },
  };
});

const post = vi.mocked(api.post);
const CID = "conv-cancel-q";

/** 仅条、尚无 messageId（快照项 / 他端）。 */
function seedQueuedBarOnly(content = "queued") {
  useConversationStore.getState().switchConversation(CID);
  useQueuedTurnsStore.getState().upsert({
    queueId: "q1",
    conversationId: CID,
    content,
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
  resetSidecarRoutingForTests();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useQueuedTurnsStore.setState({ byConversation: {} });
  resetAccountStateIngressForTests();
  installAccountStateIngress();
});

afterEach(() => {
  resetAccountStateIngressForTests();
  resetSidecarRoutingForTests();
  useQueuedTurnsStore.setState({ byConversation: {} });
  vi.unstubAllGlobals();
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
  it("HTTP 成功 → 立刻本地清条（无泡）并返回 cancelled", async () => {
    seedQueuedBarOnly();
    post.mockResolvedValueOnce({});
    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("cancelled");
    expect(post).toHaveBeenCalledWith(
      `/v1/conversations/${CID}/queued-turns/q1/cancel`,
      {},
    );
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("404（已不在队）→ 同样本地清该项并返回 already_gone", async () => {
    seedQueuedBarOnly();
    post.mockRejectedValueOnce(new ApiError(404, "{}"));
    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("already_gone");
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("404（已开跑）只清条，不删正在跑的用户泡", async () => {
    seedQueuedWithBubble();
    post.mockRejectedValueOnce(new ApiError(404, "{}"));
    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("already_gone");
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    expect(
      useConversationStore
        .getState()
        .byId[CID]?.messages.find((m) => m.id === "user-q"),
    ).toBeTruthy();
  });

  it("确认取消删掉对上的用户泡", async () => {
    seedQueuedWithBubble();
    post.mockResolvedValueOnce({});
    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("cancelled");
    expect(
      useConversationStore
        .getState()
        .byId[CID]?.messages.find((m) => m.id === "user-q"),
    ).toBeUndefined();
  });

  it("其它错误 → 抛出且不清 UI", async () => {
    seedQueuedBarOnly();
    post.mockRejectedValueOnce(new ApiError(500, "{}"));
    await expect(cancelQueuedTurn(CID, "q1")).rejects.toBeInstanceOf(ApiError);
    expect(useQueuedTurnsStore.getState().list(CID)).toHaveLength(1);
  });

  it("插话升队项亦可按 queue_id 取消", async () => {
    useConversationStore.getState().switchConversation(CID);
    useQueuedTurnsStore.getState().upsert({
      queueId: "q-ij",
      conversationId: CID,
      content: "来自插话",
      position: 1,
      queueDepth: 1,
      interjectionId: "ij-1",
    });
    post.mockResolvedValueOnce({});
    await expect(cancelQueuedTurn(CID, "q-ij")).resolves.toBe("cancelled");
    expect(post).toHaveBeenCalledWith(
      `/v1/conversations/${CID}/queued-turns/q-ij/cancel`,
      {},
    );
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("sidecar live 走 RPC，不 POST 云 cancel", async () => {
    seedQueuedBarOnly();
    setActiveSidecarTurn(CID, "root-1", "sub");
    const cancelRpc = vi.fn().mockResolvedValue({ status: "cancelled" });
    vi.stubGlobal("window", { sidecarApi: { cancelQueuedTurn: cancelRpc } });

    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("cancelled");
    expect(cancelRpc).toHaveBeenCalledWith({
      rootId: "root-1",
      subpath: "sub",
      conversationId: CID,
      queueId: "q1",
    });
    expect(post).not.toHaveBeenCalled();
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("sidecar RPC not_found → already_gone，仍清条", async () => {
    seedQueuedBarOnly();
    setActiveSidecarTurn(CID, "root-1", "");
    const cancelRpc = vi.fn().mockResolvedValue({ status: "not_found" });
    vi.stubGlobal("window", { sidecarApi: { cancelQueuedTurn: cancelRpc } });

    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("already_gone");
    expect(post).not.toHaveBeenCalled();
    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
  });

  it("executionVia=sidecar 无 live 仍走 RPC（last target）", async () => {
    seedQueuedBarOnly();
    setActiveSidecarTurn(CID, "root-1", "");
    clearActiveSidecarTurn(CID);
    useConversationStore.setState((s) => ({
      byId: {
        ...s.byId,
        [CID]: {
          ...(s.byId[CID] ?? EMPTY_RUNTIME),
          executionVia: "sidecar",
        },
      },
    }));
    const cancelRpc = vi.fn().mockResolvedValue({ status: "cancelled" });
    vi.stubGlobal("window", { sidecarApi: { cancelQueuedTurn: cancelRpc } });

    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("cancelled");
    expect(cancelRpc).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("无 sidecar live 且非本机队 → 仍走云 POST", async () => {
    seedQueuedBarOnly();
    const cancelRpc = vi.fn();
    vi.stubGlobal("window", { sidecarApi: { cancelQueuedTurn: cancelRpc } });
    post.mockResolvedValueOnce({});
    await expect(cancelQueuedTurn(CID, "q1")).resolves.toBe("cancelled");
    expect(cancelRpc).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalled();
  });
});

describe("editQueuedTurn", () => {
  it("HTTP 成功留下新正文", async () => {
    seedQueuedBarOnly();
    post.mockResolvedValueOnce({});
    await expect(
      editQueuedTurn(CID, "q1", {
        content: "改过",
        attachments: [],
        agentMentions: [],
      }),
    ).resolves.toBe("saved");
    expect(post).toHaveBeenCalledWith(
      `/v1/conversations/${CID}/queued-turns/q1/edit`,
      { content: "改过", attachments: [], agent_mentions: [] },
    );
    expect(useQueuedTurnsStore.getState().list(CID)[0]?.content).toBe("改过");
  });

  it("404 回滚本地正文并返回 already_gone", async () => {
    seedQueuedBarOnly();
    post.mockRejectedValueOnce(new ApiError(404, "{}"));
    await expect(
      editQueuedTurn(CID, "q1", {
        content: "改过",
        attachments: [],
        agentMentions: [],
      }),
    ).resolves.toBe("already_gone");
    expect(useQueuedTurnsStore.getState().list(CID)[0]?.content).not.toBe(
      "改过",
    );
  });
});
