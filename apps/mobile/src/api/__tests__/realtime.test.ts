/**
 * Firehose 客户端 —— Bearer 鉴权、只消费 ai_attention、掉线退避重连、会话真死即停。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshTokens = vi.fn();
const getTokens = vi.fn();

vi.mock("@/api/client", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
  authHeader: () => ({ Authorization: "Bearer test-access" }),
  getTokens: () => getTokens(),
  refreshTokens: () => refreshTokens(),
  // 镜像 client.fetchWithAuthRefresh，让「重放仍 401 → 清 token」这条路走到。
  fetchWithAuthRefresh: async (doFetch: () => Promise<Response>) => {
    let res = await doFetch();
    if (res.status === 401 && (await refreshTokens())) {
      res = await doFetch();
      if (res.status === 401) getTokens.mockReturnValue(null);
    }
    return res;
  },
}));

vi.mock("@/lib/clientBuildInfo", () => ({
  clientHeaders: () => ({ "X-Client-Platform": "mobile-web" }),
}));

import {
  __resetAiAttentionForTests,
  getAiAttentionSnapshot,
} from "@/lib/aiAttention";
import { startRealtime, stopRealtime } from "../realtime";

function liveStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    /** firehose 帧是扁平事件对象（非 turn 流 envelope），带 `event:` 行。 */
    push: (e: { type: string } & Record<string, unknown>) =>
      ctrl.enqueue(
        enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
      ),
    heartbeat: () => ctrl.enqueue(enc.encode(": keep-alive\n\n")),
    close: () => ctrl.close(),
  };
}

const attention = (over: Record<string, unknown> = {}) => ({
  type: "ai_attention",
  state: "required",
  conversation_id: "conv-1",
  turn_id: "turn-1",
  interaction_id: "ix-1",
  kind: "ask_user",
  title: "要不要继续部署？",
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  refreshTokens.mockReset();
  getTokens.mockReset().mockReturnValue({
    access_token: "a",
    refresh_token: "r",
  });
});

afterEach(() => {
  stopRealtime();
  __resetAiAttentionForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startRealtime · 连接", () => {
  it("以 Bearer GET /v1/realtime（不带 cookie）", async () => {
    fetchMock.mockResolvedValue(liveStream().response);
    startRealtime();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/realtime");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-access");
    expect(headers.Accept).toBe("text/event-stream");
  });

  it("没有会话时不开连接（登出后回前台不误开）", () => {
    getTokens.mockReturnValue(null);
    startRealtime();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("重复调用只开一条", async () => {
    fetchMock.mockResolvedValue(liveStream().response);
    startRealtime();
    startRealtime();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe("startRealtime · 事件消费", () => {
  it("ai_attention required/resolved 落到提醒存储", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    startRealtime();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.push(attention());
    await vi.waitFor(() => expect(getAiAttentionSnapshot()).toHaveLength(1));
    expect(getAiAttentionSnapshot()[0]).toMatchObject({
      conversationId: "conv-1",
      interactionId: "ix-1",
      title: "要不要继续部署？",
    });

    s.push(attention({ state: "resolved" }));
    await vi.waitFor(() => expect(getAiAttentionSnapshot()).toHaveLength(0));
  });

  it("其余事件类型 / 心跳 / 坏帧一律 no-op", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    startRealtime();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.push({ type: "ready" });
    s.push({ type: "chat_message", chat_id: "im-1", message: {} });
    s.push({ type: "presence", user_id: "u1", online: true });
    s.heartbeat();
    s.push(attention({ interaction_id: "ix-9" }));

    await vi.waitFor(() => expect(getAiAttentionSnapshot()).toHaveLength(1));
    expect(getAiAttentionSnapshot()[0].interactionId).toBe("ix-9");
  });
});

describe("startRealtime · 重连", () => {
  it("服务端关流后按退避重连", async () => {
    vi.useFakeTimers();
    const first = liveStream();
    const second = liveStream();
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);

    startRealtime();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 退避中，未立即重连
    await vi.advanceTimersByTimeAsync(1600);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stopRealtime 断掉在途请求并取消待重连", async () => {
    vi.useFakeTimers();
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);

    startRealtime();
    await vi.advanceTimersByTimeAsync(0);
    const { signal } = fetchMock.mock.calls[0][1] as RequestInit;
    expect((signal as AbortSignal).aborted).toBe(false);

    stopRealtime();
    expect((signal as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("401 刷新成功 → 重放即开，不进退避", async () => {
    refreshTokens.mockResolvedValue(true);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(liveStream().response);

    startRealtime();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("401 且刷新判定会话已死 → 停，不再重连", async () => {
    vi.useFakeTimers();
    // 真实 refreshTokens 在 refresh 端点 401/403 时清 token 并返回 false。
    refreshTokens.mockImplementation(async () => {
      getTokens.mockReturnValue(null);
      return false;
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    startRealtime();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("401 刷新成功但重放仍 401 → 停（token 已被清）", async () => {
    vi.useFakeTimers();
    refreshTokens.mockResolvedValue(true);
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    startRealtime();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getTokens()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("空闲超时（无心跳）取消死连接并重连", async () => {
    vi.useFakeTimers();
    const first = liveStream();
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(liveStream().response);

    startRealtime();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 后端每 25s 心跳；彻底静默 60s = socket 已死。
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(1600);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
