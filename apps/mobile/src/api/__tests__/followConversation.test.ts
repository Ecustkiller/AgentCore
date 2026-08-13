/**
 * 对话级订阅（云对话多端同权 B2）—— 一条连接跨多个回合。
 *
 * 锁三件事：首个回合段照 attach 语义整段送达；「边界注释之前先来心跳」= 连上来就空闲
 * （旧 204 的等价物，且不含时序假设）；此后每个新回合都在同一条流上继续送。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
  authHeader: () => ({ Authorization: "Bearer test-access" }),
  fetchWithAuthRefresh: (doFetch: () => Promise<Response>) => doFetch(),
}));

vi.mock("@/lib/clientBuildInfo", () => ({
  clientHeaders: () => ({ "X-Client-Platform": "mobile-web" }),
}));

import { StreamHttpError } from "@/lib/errors";
import type { SSEEvent } from "@agentcore/contract-types";
import { followConversation } from "../stream";

/** 服务端那条流：`_conversation_generator` 会发的三种帧。 */
function liveStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const write = (s: string) => ctrl.enqueue(enc.encode(s));
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    event: (type: string, payload: Record<string, unknown> = {}) =>
      write(
        `event: ${type}\ndata: ${JSON.stringify({
          type,
          timestamp: "2026-01-01T00:00:00Z",
          payload,
        })}\n\n`,
      ),
    caughtUp: () => write(": attach-caught-up\n\n"),
    ping: () => write(": ping\n\n"),
    close: () => ctrl.close(),
  };
}

function collector() {
  const events: SSEEvent[] = [];
  const idle = vi.fn();
  return {
    events,
    idle,
    types: () => events.map((e) => e.type),
    onEvent: (e: SSEEvent) => {
      events.push(e);
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("followConversation · 请求", () => {
  it("带 follow=true + Bearer + Last-Event-ID 打对话流端点", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const sink = collector();
    const done = followConversation("conv-req", sink.onEvent, sink.idle);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://api.test/v1/conversations/conv-req/stream?follow=true",
    );
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-access");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["Last-Event-ID"]).toBe("0");

    s.close();
    await done;
  });

  it("非 2xx 抛 StreamHttpError（错误体照常解出 code）", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), {
        status: 403,
      }),
    );
    const sink = collector();
    await expect(
      followConversation("conv-403", sink.onEvent, sink.idle),
    ).rejects.toBeInstanceOf(StreamHttpError);
  });

  it("老后端不认 follow 仍 204 → 报空闲收场，不抛", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const sink = collector();
    await followConversation("conv-204", sink.onEvent, sink.idle);
    expect(sink.idle).toHaveBeenCalledTimes(1);
    expect(sink.events).toHaveLength(0);
  });
});

describe("followConversation · 连上来时有回合在跑", () => {
  it("首段缓冲到边界注释才整段送出（已完工的队员不重新动画）", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const sink = collector();
    const done = followConversation("conv-live", sink.onEvent, sink.idle);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.event("message_start", { message_id: "m1" });
    s.event("content_delta", { delta: "已经说了一半" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.events).toHaveLength(0); // 还在缓冲

    s.caughtUp();
    await vi.waitFor(() => expect(sink.events).toHaveLength(2));
    expect(sink.types()).toEqual(["message_start", "content_delta"]);

    s.event("content_delta", { delta: "继续" });
    await vi.waitFor(() => expect(sink.events).toHaveLength(3));
    expect(sink.idle).not.toHaveBeenCalled();

    s.close();
    await done;
  });

  it("边界之后的心跳只是「回合静默」，不得报空闲", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const sink = collector();
    const done = followConversation("conv-quiet", sink.onEvent, sink.idle);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.event("message_start", { message_id: "m1" });
    s.caughtUp();
    await vi.waitFor(() => expect(sink.events).toHaveLength(1));

    s.ping();
    s.ping();
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.idle).not.toHaveBeenCalled();

    s.close();
    await done;
  });
});

describe("followConversation · 停在空闲对话上", () => {
  it("边界之前先收心跳 = 连上来就空闲，只报一次", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const sink = collector();
    const done = followConversation("conv-idle", sink.onEvent, sink.idle);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.ping();
    await vi.waitFor(() => expect(sink.idle).toHaveBeenCalledTimes(1));
    s.ping();
    s.ping();
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.idle).toHaveBeenCalledTimes(1);

    s.close();
    await done;
  });

  it("另一端起回合 → 同一条流上继续送（含新回合的 message_start）", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const sink = collector();
    const done = followConversation("conv-next", sink.onEvent, sink.idle);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.ping();
    await vi.waitFor(() => expect(sink.idle).toHaveBeenCalledTimes(1));

    // 另一端发消息：新回合的重放段 → 边界 → 实时帧 → 收口。
    s.event("message_start", { message_id: "m-remote" });
    s.caughtUp();
    s.event("content_delta", { delta: "另一端起的回合" });
    s.event("message_end", { finish_reason: "end_turn" });
    await vi.waitFor(() => expect(sink.events).toHaveLength(3));
    expect(sink.types()).toEqual([
      "message_start",
      "content_delta",
      "message_end",
    ]);
    expect((sink.events[0].payload as { message_id: string }).message_id).toBe(
      "m-remote",
    );

    // 回合收口后回到等待态：心跳不再报空闲（已报过），流也不断。
    s.ping();
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.idle).toHaveBeenCalledTimes(1);

    // 再来一个回合仍然收得到，且 message_id 变了 = 调用方据此另开气泡。
    s.event("message_start", { message_id: "m-remote-2" });
    s.caughtUp();
    s.event("content_delta", { delta: "第二个回合" });
    await vi.waitFor(() => expect(sink.events).toHaveLength(5));
    expect((sink.events[3].payload as { message_id: string }).message_id).toBe(
      "m-remote-2",
    );

    s.close();
    await done;
  });
});

describe("followConversation · 收尾", () => {
  it("服务端关流时首段还没等到边界 → 兜底刷出，不吞帧", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const sink = collector();
    const done = followConversation("conv-cut", sink.onEvent, sink.idle);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.event("message_start", { message_id: "m1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.events).toHaveLength(0);

    s.close();
    await done;
    expect(sink.types()).toEqual(["message_start"]);
  });
});
