/**
 * 对话级订阅（云对话多端同权 B2 · 验收 4）。
 *
 * 覆盖三条硬边界：空闲不转圈、另一端开跑能自动出现 + 跟播、与本端自有连接互斥
 * （同一回合绝不折两次）。
 */
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dispatchMod from "../sse/dispatch";
import {
  followedConversationIds,
  stopAllConversationFollows,
  syncConversationFollow,
} from "../turns/conversationFollow";
import {
  beginLocalConversationStream,
  resetStreamOwnershipForTests,
} from "../turns/streamOwnership";

const { loadLatestWindow, reconcileQueuedTurns } = vi.hoisted(() => ({
  loadLatestWindow: vi.fn(async () => true),
  reconcileQueuedTurns: vi.fn(async () => {}),
}));

vi.mock("@/services/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/messages")>()),
  loadLatestWindow,
}));

vi.mock("../turns/reconcileQueuedTurns", () => ({ reconcileQueuedTurns }));

const CID = "conv-follow";

/** A pushable SSE body so a test can drive frame-by-frame timing. */
function sseStream(): {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* already closed */
        }
      };
      close = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push,
    close,
  };
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, timestamp: "t", payload })}\n\n`;
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

let dispatched: string[] = [];

beforeEach(() => {
  dispatched = [];
  loadLatestWindow.mockClear();
  reconcileQueuedTurns.mockClear();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  vi.spyOn(dispatchMod, "dispatchSSEEvent").mockImplementation((event) => {
    dispatched.push(event.type);
  });
  vi.spyOn(dispatchMod, "flushPendingContent").mockImplementation(() => {});
  vi.spyOn(dispatchMod, "flushPendingFrames").mockImplementation(() => {});
});

afterEach(() => {
  stopAllConversationFollows();
  resetStreamOwnershipForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

describe("syncConversationFollow (对话级订阅)", () => {
  it("订阅对话而非回合：带 follow=true，空闲只收心跳且不写任何回合态", async () => {
    const { response, push, close } = sseStream();
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(response));
    vi.stubGlobal("fetch", fetchMock);

    syncConversationFollow(CID);
    await tick();

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/v1/conversations/${CID}/stream?follow=true`,
    );

    push(": ping\n\n");
    push(": ping\n\n");
    await tick();

    // 「对话确实空闲」不得变成永远转圈的空气泡。
    expect(getRuntime(CID).messages).toHaveLength(0);
    expect(getRuntime(CID).isGenerating).toBe(false);
    expect(getRuntime(CID).abort).toBeNull();
    expect(dispatched).toEqual([]);
    close();
  });

  it("另一端开跑：先拉齐消息窗（SSE 不带用户提问），再整段折一次并跟播", async () => {
    const { response, push, close } = sseStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response)),
    );

    syncConversationFollow(CID);
    await tick();

    // 空闲连接的首个边界：没有可折的 catch-up 段，别白拉一次窗口。
    push(": attach-caught-up\n\n");
    await tick();
    expect(loadLatestWindow).not.toHaveBeenCalled();

    push(frame("message_start", { message_id: "srv-1" }));
    push(frame("content_delta", { delta: "你" }));
    await tick();

    expect(loadLatestWindow).toHaveBeenCalledTimes(1);
    expect(loadLatestWindow).toHaveBeenCalledWith(CID, { softRefresh: true });

    push(frame("content_delta", { delta: "好" }));
    push(frame("message_end", { finish_reason: "end_turn" }));
    await tick();

    // 每帧恰好折一次，且顺序不因回补窗口而错位。
    expect(dispatched).toEqual([
      "message_start",
      "content_delta",
      "content_delta",
      "message_end",
    ]);
    close();
  });

  it("本端自有连接期间不连；释放后自动连回", async () => {
    const { response, close } = sseStream();
    const fetchMock = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal("fetch", fetchMock);

    const release = beginLocalConversationStream(CID);
    syncConversationFollow(CID);
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();

    release();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    close();
  });

  it("本端开回合流时立刻让位：让位后到达的帧一律不折（同一回合不双折）", async () => {
    const { response, push, close } = sseStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response)),
    );

    syncConversationFollow(CID);
    await tick();
    push(": attach-caught-up\n\n");
    await tick();

    // 本端 POST 回合流开张（sendTurn / midFlight 都走这道闸）。
    beginLocalConversationStream(CID);
    push(frame("message_start", { message_id: "srv-2" }));
    push(frame("content_delta", { delta: "x" }));
    await tick();

    expect(dispatched).toEqual([]);
    expect(loadLatestWindow).not.toHaveBeenCalled();
    close();
  });

  it("切到别的会话：空闲订阅立刻关，且只留一条订阅", async () => {
    const streams = [sseStream(), sseStream()];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(streams[call++]?.response ?? streams[0].response),
      ),
    );

    syncConversationFollow(CID);
    await tick();
    expect(followedConversationIds()).toEqual([CID]);

    syncConversationFollow("conv-other");
    await tick();
    expect(followedConversationIds()).toEqual(["conv-other"]);

    for (const s of streams) s.close();
  });

  it("正在跟播时切走不硬卸泵：等回合收口的心跳再关", async () => {
    const { response, push, close } = sseStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response)),
    );

    syncConversationFollow(CID);
    await tick();
    useConversationStore.getState().setGenerating(true, CID);

    syncConversationFollow(null);
    await tick();
    expect(followedConversationIds()).toEqual([CID]); // 仍在跟播 → 延后关

    useConversationStore.getState().setGenerating(false, CID);
    push(": ping\n\n");
    await tick();
    expect(followedConversationIds()).toEqual([]);
    close();
  });
});
