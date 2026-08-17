/**
 * Fulfill observer —— Bearer GET、无 token 不开、只把 turn activity 推进 store、
 * 其余帧 no-op、停掉不重连。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshTokens = vi.fn();
const getTokens = vi.fn();

vi.mock("@/api/client", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
  authHeader: () => ({ Authorization: "Bearer test-access" }),
  getTokens: () => getTokens(),
  refreshTokens: () => refreshTokens(),
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
  __resetAiTurnActivityForTests,
  getAiTurnActivityRunning,
} from "@/lib/aiTurnActivity";
import {
  __resetConversationListCacheForTests,
  getConversationListGrouped,
  replaceGrouped,
} from "@/lib/conversationListCache";
import { __resetFulfillForTests, startFulfill, stopFulfill } from "../fulfill";

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
    push: (e: { type: string } & Record<string, unknown>) =>
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)),
    raw: (chunk: string) => ctrl.enqueue(enc.encode(chunk)),
    heartbeat: () => ctrl.enqueue(enc.encode(": keep-alive\n\n")),
    close: () => ctrl.close(),
  };
}

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
  __resetFulfillForTests();
  __resetAiTurnActivityForTests();
  __resetConversationListCacheForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startFulfill · 连接", () => {
  it("以 Bearer GET /v1/fulfill（空 caps/roots，device_id=mobile-uuid）", async () => {
    fetchMock.mockResolvedValue(liveStream().response);
    startFulfill();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("http://api.test/v1/fulfill");
    expect(parsed.searchParams.get("caps")).toBe("");
    expect(parsed.searchParams.get("roots")).toBe("");
    expect(parsed.searchParams.get("device_id")).toMatch(/^mobile-/);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-access");
    expect(headers.Accept).toBe("text/event-stream");
  });

  it("没有会话时不开连接（登出后回前台不误开）", () => {
    getTokens.mockReturnValue(null);
    startFulfill();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("startFulfill · 事件消费", () => {
  it("只把 turn activity 推进 store", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    startFulfill();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.push({
      type: "ai_turn_activity_snapshot",
      payload: { running: ["conv-a"] },
    });
    await vi.waitFor(() =>
      expect(getAiTurnActivityRunning()).toEqual(["conv-a"]),
    );

    s.push({
      type: "ai_turn_activity",
      payload: { conversation_id: "conv-b", state: "running" },
    });
    await vi.waitFor(() =>
      expect(getAiTurnActivityRunning()).toEqual(["conv-a", "conv-b"]),
    );

    s.push({
      type: "ai_turn_activity",
      payload: {
        conversation_id: "conv-a",
        state: "done",
        reason: "completed",
      },
    });
    await vi.waitFor(() =>
      expect(getAiTurnActivityRunning()).toEqual(["conv-b"]),
    );
  });

  it("running 帧 bump 已在缓存里的行，done 不 bump", async () => {
    const seededAt = "2026-01-01T00:00:00Z";
    replaceGrouped({
      folders: [],
      ungrouped: [
        {
          id: "conv-b",
          title: "对话",
          archived: false,
          context_compacted: false,
          created_at: seededAt,
          deep_research_auto: false,
          message_count: 0,
          pinned: false,
          updated_at: seededAt,
        },
      ],
    });

    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    startFulfill();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.push({
      type: "ai_turn_activity",
      payload: { conversation_id: "conv-b", state: "running" },
    });
    await vi.waitFor(() => {
      const at = getConversationListGrouped()?.ungrouped[0]?.updated_at;
      expect(at).toBeTruthy();
      expect(at).not.toBe(seededAt);
    });
    const bumpedAt = getConversationListGrouped()?.ungrouped[0]?.updated_at;

    s.push({
      type: "ai_turn_activity",
      payload: { conversation_id: "conv-b", state: "done" },
    });
    await vi.waitFor(() => expect(getAiTurnActivityRunning()).toEqual([]));
    expect(getConversationListGrouped()?.ungrouped[0]?.updated_at).toBe(
      bumpedAt,
    );
  });

  it("queue / attention / CLIENT_TOOL / ready / 心跳 / 坏帧一律 no-op", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    startFulfill();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    s.push({ type: "ready" });
    s.push({
      type: "turn_queue_snapshot",
      payload: { conversation_id: "c1", items: [] },
    });
    s.push({
      type: "ai_attention",
      payload: { state: "required", conversation_id: "c1" },
    });
    s.push({
      type: "workspace_op_required",
      payload: { request_id: "r1" },
    });
    s.heartbeat();
    s.raw("data: {not-json\n\n");
    s.push({
      type: "ai_turn_activity_snapshot",
      payload: { running: ["conv-ok"] },
    });

    await vi.waitFor(() =>
      expect(getAiTurnActivityRunning()).toEqual(["conv-ok"]),
    );
  });
});

describe("startFulfill · 停掉", () => {
  it("stopFulfill 断掉在途请求并取消待重连", async () => {
    vi.useFakeTimers();
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);

    startFulfill();
    await vi.advanceTimersByTimeAsync(0);
    const { signal } = fetchMock.mock.calls[0][1] as RequestInit;
    expect((signal as AbortSignal).aborted).toBe(false);

    stopFulfill();
    expect((signal as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
