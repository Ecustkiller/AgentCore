/**
 * Mobile browser live SSE client — auth header / session_id pin / envelope mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshTokens = vi.fn();
const getTokens = vi.fn();

vi.mock("@/api/client", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
  authHeader: () => ({ Authorization: "Bearer test-access" }),
  getTokens: () => getTokens(),
  refreshTokens: () => refreshTokens(),
  // Mirror client.fetchWithAuthRefresh so still-401 clearing is exercised via mocks.
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

import { type BrowserLiveHandlers, startBrowserLive } from "../browserLive";

function handlers() {
  return {
    onFrame: vi.fn(),
    onStatus: vi.fn(),
    onConnection: vi.fn(),
  } satisfies BrowserLiveHandlers;
}

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
    push: (e: unknown) =>
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)),
    close: () => ctrl.close(),
  };
}

const conn = (h: ReturnType<typeof handlers>) =>
  h.onConnection.mock.calls.map((c) => c[0]);

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startBrowserLive · auth + session pin", () => {
  it("GETs live with Bearer (no credentials) and pins session_id", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const h = handlers();
    const client = startBrowserLive("conv-42", "sess-tab-1", h);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/conversations/conv-42/browser/live?");
    expect(url).toContain("session_id=sess-tab-1");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-access");
    expect(headers.Accept).toBe("text/event-stream");
    client.stop();
  });

  it("rejects empty session_id before fetch", () => {
    expect(() => startBrowserLive("c1", "  ", handlers())).toThrow(
      /session_id required/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards frame/status envelopes and connecting → open", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const h = handlers();
    const client = startBrowserLive("c1", "s1", h);

    await vi.waitFor(() => expect(conn(h)).toEqual(["connecting", "open"]));
    s.push({ type: "browser_live_status", payload: { state: "started" } });
    s.push({
      type: "browser_live_frame",
      payload: { frame_b64: "AAAA", width: 1280, height: 720 },
    });

    await vi.waitFor(() =>
      expect(h.onFrame).toHaveBeenCalledWith({
        frame_b64: "AAAA",
        width: 1280,
        height: 720,
      }),
    );
    expect(h.onStatus).toHaveBeenCalledWith("started");
    client.stop();
  });

  it("stop() aborts the in-flight request", async () => {
    const s = liveStream();
    fetchMock.mockResolvedValue(s.response);
    const h = handlers();
    const client = startBrowserLive("c1", "s1", h);

    await vi.waitFor(() => expect(conn(h)).toContain("open"));
    const { signal } = fetchMock.mock.calls[0][1] as RequestInit;
    expect((signal as AbortSignal).aborted).toBe(false);
    client.stop();
    expect((signal as AbortSignal).aborted).toBe(true);
  });

  it("401 → refresh success → replay opens (no delayed reconnect)", async () => {
    refreshTokens.mockResolvedValue(true);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(liveStream().response);
    const h = handlers();
    const client = startBrowserLive("c1", "s1", h);

    await vi.waitFor(() => expect(refreshTokens).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(conn(h)).toContain("open"));
    expect(conn(h)).not.toContain("reconnecting");
    client.stop();
  });

  it("401 → auth dead (tokens cleared) → stop without reconnect", async () => {
    vi.useFakeTimers();
    refreshTokens.mockResolvedValue(false);
    getTokens.mockReturnValue(null);
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const h = handlers();
    const client = startBrowserLive("c1", "s1", h);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("401 → refresh ok but replay still 401 → stop (clears tokens)", async () => {
    vi.useFakeTimers();
    refreshTokens.mockResolvedValue(true);
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const h = handlers();
    const client = startBrowserLive("c1", "s1", h);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(getTokens()).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.stop();
  });
});
