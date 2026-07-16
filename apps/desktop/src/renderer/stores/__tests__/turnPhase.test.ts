import { ensureStreamingAssistant } from "@/services/sse/contentBuffer";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import { stopConversation } from "@/services/stopTurn";
import {
  beginTurnPreflight,
  enterTurnStreaming,
  getRuntime,
  getTurnPhase,
  resetTurnPhaseTimers,
  throwIfCannotOpenStream,
  useConversationStore,
} from "@/stores/conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({
  api: {
    post: vi.fn(),
  },
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
}));

import { notifyError } from "@/lib/toast";
import { api } from "@/services/api";

const CID = "conv-turn-phase";
const apiPost = vi.mocked(api.post);
const notifyErrorMock = vi.mocked(notifyError);

beforeEach(() => {
  resetTurnPhaseTimers();
  useConversationStore.setState({ currentConversationId: CID, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  apiPost.mockReset();
  notifyErrorMock.mockReset();
});

afterEach(() => {
  resetTurnPhaseTimers();
});

describe("turn stop lifecycle", () => {
  it("预检期间停止 → throwIfCannotOpenStream 阻断开流", () => {
    beginTurnPreflight(CID);
    expect(getTurnPhase(CID)).toBe("preflight");

    useConversationStore.getState().stopGeneration();
    expect(getTurnPhase(CID)).toBe("stopping");
    expect(getRuntime(CID).isGenerating).toBe(false);

    expect(() => throwIfCannotOpenStream(CID)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("已 abort 的 signal → throwIfCannotOpenStream 阻断", () => {
    beginTurnPreflight(CID);
    const ac = new AbortController();
    ac.abort();
    expect(() => throwIfCannotOpenStream(CID, ac.signal)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("停止后迟到 content_delta / tool 事件被丢弃，不重建气泡、不拉回 isGenerating", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    const beforeCount = getRuntime(CID).messages.length;

    useConversationStore.getState().stopGeneration();
    expect(getTurnPhase(CID)).toBe("stopping");
    expect(getRuntime(CID).isGenerating).toBe(false);

    dispatchSSEEvent(
      {
        type: "content_delta",
        payload: { delta: "迟到正文" },
      } as never,
      { conversationId: CID, source: "server" },
    );
    dispatchSSEEvent(
      {
        type: "tool_use_start",
        payload: {
          tool_use_id: "t1",
          tool_name: "web_search",
          input: {},
        },
      } as never,
      { conversationId: CID, source: "server" },
    );
    dispatchSSEEvent(
      {
        type: "message_start",
        payload: { message_id: "m-late", trace_id: null },
      } as never,
      { conversationId: CID, source: "server" },
    );

    ensureStreamingAssistant(CID);

    expect(getRuntime(CID).isGenerating).toBe(false);
    expect(getRuntime(CID).messages.length).toBe(beforeCount);
    const last = getRuntime(CID).messages.at(-1);
    expect(last?.content ?? "").not.toContain("迟到正文");
    expect(last?.isStreaming).toBe(false);
  });

  it("message_end 正常路径推进 terminal completed", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);

    dispatchSSEEvent(
      {
        type: "message_end",
        payload: {
          finish_reason: "stop",
          rounds: 1,
        },
      } as never,
      { conversationId: CID, source: "server" },
    );

    expect(getTurnPhase(CID)).toBe("completed");
    expect(getRuntime(CID).isGenerating).toBe(false);
  });

  it("stopping 态收到 message_end → terminal stopped", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    useConversationStore.getState().stopGeneration();
    expect(getTurnPhase(CID)).toBe("stopping");

    dispatchSSEEvent(
      {
        type: "message_end",
        payload: {
          finish_reason: "cancelled",
          rounds: 1,
        },
      } as never,
      { conversationId: CID, source: "server" },
    );

    expect(getTurnPhase(CID)).toBe("stopped");
  });

  it("/stop 失败时 notifyError 可见提示", async () => {
    apiPost.mockRejectedValueOnce(new Error("network down"));
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);

    useConversationStore.getState().stopGeneration();

    // stopConversation is fire-and-forget; flush microtasks
    await vi.waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledWith(
        "停止请求失败，引擎可能仍在后台运行",
      );
    });
  });

  it("新回合 beginTurnPreflight 从 terminal 正确重置", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().setTurnPhase("completed", CID);
    expect(getTurnPhase(CID)).toBe("completed");

    beginTurnPreflight(CID);
    expect(getTurnPhase(CID)).toBe("preflight");
    enterTurnStreaming(CID);
    expect(getTurnPhase(CID)).toBe("streaming");
  });
});

describe("stopConversation", () => {
  it("成功时返回 stopped 标志且不再吞错", async () => {
    apiPost.mockResolvedValueOnce({ stopped: true });
    await expect(stopConversation(CID)).resolves.toBe(true);
    expect(apiPost).toHaveBeenCalledWith(`/v1/conversations/${CID}/stop`);
  });

  it("失败时向上抛出", async () => {
    apiPost.mockRejectedValueOnce(new Error("boom"));
    await expect(stopConversation(CID)).rejects.toThrow("boom");
  });
});
