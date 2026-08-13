import type { AuthRefreshResult } from "@/services/api";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getDeviceIdMock,
  tryRefreshMock,
  notifyUnauthorizedMock,
  apiPostMock,
  isWebRuntimeMock,
} = vi.hoisted(() => ({
  getDeviceIdMock: vi.fn(async () => "device-test-1"),
  tryRefreshMock: vi.fn(async (): Promise<AuthRefreshResult> => "renewed"),
  notifyUnauthorizedMock: vi.fn(),
  apiPostMock: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => undefined,
  ),
  isWebRuntimeMock: vi.fn(() => false),
}));

vi.mock("@/lib/capabilities", () => ({
  isWebRuntime: () => isWebRuntimeMock(),
}));

vi.mock("@/lib/clientBuildInfo", () => ({
  clientHeaders: () => ({ "X-Client-Platform": "desktop" }),
}));

vi.mock("@/services/deviceIdentity", () => ({
  getDeviceId: () => getDeviceIdMock(),
  resetDeviceIdentityForTests: () => undefined,
}));

vi.mock("@/services/api", () => ({
  BASE_URL: "http://localhost:8000",
  api: { post: (...args: unknown[]) => apiPostMock(...args) },
  getCsrfHeaders: () => ({}),
  tryRefresh: () => tryRefreshMock(),
  notifyUnauthorized: () => notifyUnauthorizedMock(),
}));

import {
  FULFILL_CAPS,
  onFulfillFrame,
  resetFulfillStreamForTests,
  startFulfillStream,
  stopFulfillStream,
} from "../fulfillStream";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fresh SSE response per fetch — a Response body is single-use. */
function sseResponse(opts: { end?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"ready"}\n\n'));
        if (opts.end) controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** Roots declared on one `GET /v1/fulfill` call (`""` = declared empty). */
function declaredRoots(call: unknown[] | undefined): string | null {
  return new URL(String(call?.[0])).searchParams.get("roots");
}

describe("fulfillStream", () => {
  const listRoots = vi.fn(async () => [{ id: "root-a", name: "A" }]);
  /** Latest `fs:rootsChanged` subscriber, so a test can fire the grant event. */
  let rootsChangedCb: (() => void) | null = null;
  const onRootsChanged = vi.fn((cb: () => void) => {
    rootsChangedCb = cb;
    return () => {
      rootsChangedCb = null;
    };
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetFulfillStreamForTests();
    getDeviceIdMock.mockReset().mockResolvedValue("device-test-1");
    tryRefreshMock.mockReset().mockResolvedValue("renewed");
    notifyUnauthorizedMock.mockReset();
    apiPostMock.mockReset().mockResolvedValue(undefined);
    isWebRuntimeMock.mockReset().mockReturnValue(false);
    listRoots.mockReset().mockResolvedValue([{ id: "root-a", name: "A" }]);
    rootsChangedCb = null;
    onRootsChanged.mockClear();
    (
      window as unknown as {
        fsApi: {
          listRoots: typeof listRoots;
          onRootsChanged: typeof onRootsChanged;
        };
      }
    ).fsApi = { listRoots, onRootsChanged };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    resetFulfillStreamForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects GET /v1/fulfill with device_id, caps, roots", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('event: ready\ndata: {"type":"ready"}\n\n'),
            );
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    startFulfillStream();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("http://localhost:8000/v1/fulfill?");
    expect(url).toContain("device_id=device-test-1");
    expect(url).toContain(`caps=${encodeURIComponent(FULFILL_CAPS.join(","))}`);
    expect(url).toContain("roots=root-a");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({
      Accept: "text/event-stream",
      "X-Client-Platform": "desktop",
    });

    stopFulfillStream();
  });

  it("fans out ready / *_required / client_tool_cancelled frames", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'data: {"type":"ready"}\n\n',
                  'data: {"type":"workspace_op_required","payload":{"request_id":"r1"}}\n\n',
                  'data: {"type":"client_tool_cancelled","request_id":"r1"}\n\n',
                ].join(""),
              ),
            );
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const frames: unknown[] = [];
    const unsub = onFulfillFrame((f) => frames.push(f));
    startFulfillStream();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(frames).toEqual([
      { type: "ready" },
      { type: "workspace_op_required", payload: { request_id: "r1" } },
      { type: "client_tool_cancelled", request_id: "r1" },
    ]);
    unsub();
    stopFulfillStream();
  });

  it("on 401 refreshes then reconnects; auth_dead stops and notifies", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"ready"}\n\n'),
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );

    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(tryRefreshMock).toHaveBeenCalled();
    // reconnect scheduled with base backoff
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    stopFulfillStream();

    // auth_dead path
    resetFulfillStreamForTests();
    tryRefreshMock.mockResolvedValueOnce("auth_dead");
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyUnauthorizedMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stopFulfillStream();
  });

  it("uses exponential backoff after transport failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new TypeError("offline"));

    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // second failure → 2000ms backoff
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    stopFulfillStream();
    vi.mocked(Math.random).mockRestore();
  });

  it("POSTs /v1/fulfill/roots on fs:rootsChanged (no reconnect, no polling)", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"ready"}\n\n'));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    // catch-up POST on connect
    expect(apiPostMock).toHaveBeenCalledWith("/v1/fulfill/roots", {
      device_id: "device-test-1",
      roots: ["root-a"],
    });
    const postsAfterConnect = apiPostMock.mock.calls.length;
    const fetchesAfterConnect = fetchMock.mock.calls.length;

    listRoots.mockResolvedValue([
      { id: "root-a", name: "A" },
      { id: "root-b", name: "B" },
    ]);
    // Nothing re-declares until the main process reports the grant change.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(apiPostMock.mock.calls.length).toBe(postsAfterConnect);

    rootsChangedCb?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(apiPostMock.mock.calls.length).toBeGreaterThan(postsAfterConnect);
    expect(apiPostMock).toHaveBeenCalledWith("/v1/fulfill/roots", {
      device_id: "device-test-1",
      roots: ["root-a", "root-b"],
    });
    // no reconnect solely for roots change
    expect(fetchMock.mock.calls.length).toBe(fetchesAfterConnect);

    stopFulfillStream();
  });

  it("授权根读不出来时保持既有声明，不上报空集", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => sseResponse());

    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(apiPostMock).toHaveBeenCalledWith("/v1/fulfill/roots", {
      device_id: "device-test-1",
      roots: ["root-a"],
    });
    const postsAfterConnect = apiPostMock.mock.calls.length;

    // 主进程读授权根失败（IPC 挂了）——这不等于「用户撤了权」
    listRoots.mockRejectedValue(new Error("IPC 不可用"));
    rootsChangedCb?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(apiPostMock).not.toHaveBeenCalledWith("/v1/fulfill/roots", {
      device_id: "device-test-1",
      roots: [],
    });
    expect(apiPostMock.mock.calls.length).toBe(postsAfterConnect);
    expect(warn).toHaveBeenCalled();

    stopFulfillStream();
    warn.mockRestore();
  });

  it("读取失败时重连仍声明上次已知 roots", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.mocked(fetch);
    // 每次连上即收尾 → 走真实重连路径
    fetchMock.mockImplementation(async () => sseResponse({ end: true }));

    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(declaredRoots(fetchMock.mock.calls[0])).toBe("root-a");

    listRoots.mockRejectedValue(new Error("IPC 不可用"));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // 重连的 GET 会整体替换 hub 里的 session：读不到就不能把 roots 缩成空集
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(declaredRoots(fetchMock.mock.calls[1])).toBe("root-a");
    expect(apiPostMock).not.toHaveBeenCalledWith("/v1/fulfill/roots", {
      device_id: "device-test-1",
      roots: [],
    });

    stopFulfillStream();
    warn.mockRestore();
    vi.mocked(Math.random).mockRestore();
  });

  it("用户撤销全部授权 → 如实上报空集，重连也声明空集", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => sseResponse());

    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(apiPostMock).toHaveBeenCalledWith("/v1/fulfill/roots", {
      device_id: "device-test-1",
      roots: ["root-a"],
    });

    listRoots.mockResolvedValue([]);
    rootsChangedCb?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(apiPostMock).toHaveBeenCalledWith("/v1/fulfill/roots", {
      device_id: "device-test-1",
      roots: [],
    });

    // 撤权后再连：上次已知集合不得把真实空集盖回去
    stopFulfillStream();
    startFulfillStream();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(declaredRoots(fetchMock.mock.calls.at(-1))).toBe("");

    stopFulfillStream();
  });

  it("no-ops on web runtime", async () => {
    isWebRuntimeMock.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    startFulfillStream();
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
