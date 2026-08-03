/**
 * Mobile browser takeover/input client — auth via apiFetch, session_id pin, wire body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  type BrowserInputEvent,
  TakeoverStartError,
  createInputBatcher,
  endBrowserTakeover,
  sendBrowserInput,
  sendInput,
  startBrowserTakeover,
  takeoverStartErrorMessage,
  toFrameSpace,
} from "../browserTakeover";

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  apiFetch
    .mockReset()
    .mockResolvedValue(jsonOk({ active: true, reason: "started" }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("browserTakeover · REST + session pin", () => {
  it("starts takeover with action+session_id body", async () => {
    const state = await startBrowserTakeover("conv-42", "sess-1");
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/conv-42/browser/takeover",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", session_id: "sess-1" }),
      }),
    );
    expect(state).toEqual({ active: true, reason: "started" });
  });

  it("ends takeover with action+session_id", async () => {
    await endBrowserTakeover("conv-42", "sess-1");
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/conv-42/browser/takeover",
      expect.objectContaining({
        body: JSON.stringify({ action: "end", session_id: "sess-1" }),
      }),
    );
  });

  it("treats already_active as success", async () => {
    apiFetch.mockResolvedValue(
      jsonOk({
        active: true,
        reason: "already_active",
        started_at: "2026-07-25T00:00:00Z",
      }),
    );
    const state = await startBrowserTakeover("c1", "s1");
    expect(state.reason).toBe("already_active");
  });

  it("throws TakeoverStartError on no_session", async () => {
    apiFetch.mockResolvedValue(jsonOk({ active: false, reason: "no_session" }));
    await expect(startBrowserTakeover("c1", "s1")).rejects.toEqual(
      expect.objectContaining({
        name: "TakeoverStartError",
        reason: "no_session",
      }),
    );
  });

  it("posts input with events + session_id (never omits pin)", async () => {
    const events: BrowserInputEvent[] = [
      { kind: "mouse", type: "down", x: 10, y: 20, button: 0, click_count: 1 },
      { kind: "key", type: "down", key: "a", code: "KeyA" },
    ];
    apiFetch.mockResolvedValue(jsonOk({ injected: 2 }));
    await sendBrowserInput("c1", "sess-pin", events);
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/c1/browser/input",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ events, session_id: "sess-pin" }),
      }),
    );
  });

  it("sendInput alias pins session_id the same way", async () => {
    apiFetch.mockResolvedValue(jsonOk({ injected: 1 }));
    await sendInput("c1", "sid", [{ kind: "text", text: "hi" }]);
    const body = JSON.parse(
      (apiFetch.mock.calls[0][1] as RequestInit).body as string,
    ) as { session_id: string };
    expect(body.session_id).toBe("sid");
  });

  it("does not POST an empty input batch", async () => {
    await sendBrowserInput("c1", "s1", []);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects blank session_id", async () => {
    await expect(startBrowserTakeover("c1", "")).rejects.toThrow(
      /session_id required/,
    );
    await expect(
      sendBrowserInput("c1", "  ", [{ kind: "text", text: "x" }]),
    ).rejects.toThrow(/session_id required/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("encodes conversation id in the path", async () => {
    await startBrowserTakeover("a/b?c", "s1");
    expect(apiFetch.mock.calls[0][0]).toBe(
      "/v1/conversations/a%2Fb%3Fc/browser/takeover",
    );
  });
});

describe("takeoverStartErrorMessage", () => {
  it("maps known reasons", () => {
    expect(
      takeoverStartErrorMessage(new TakeoverStartError("no_session")),
    ).toContain("没有进行中");
    expect(takeoverStartErrorMessage("not_active")).toContain(
      "没有进行中的接管",
    );
  });

  it("falls back to a generic default", () => {
    expect(takeoverStartErrorMessage(new Error("x"))).toBe(
      "无法接管浏览器，请重试",
    );
  });
});

describe("toFrameSpace", () => {
  it("maps display center to frame center (letterboxed)", () => {
    const rect = { left: 0, top: 0, width: 1000, height: 500 };
    expect(toFrameSpace(500, 250, rect, 1000, 1000)).toEqual({
      x: 500,
      y: 500,
    });
  });

  it("returns (0,0) for degenerate frame", () => {
    expect(
      toFrameSpace(5, 5, { left: 0, top: 0, width: 100, height: 100 }, 0, 0),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("createInputBatcher", () => {
  it("flushes after the interval and coalesces moves", () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const b = createInputBatcher(send, 60);
    b.push({ kind: "mouse", type: "move", x: 1, y: 1 });
    b.push({ kind: "mouse", type: "move", x: 2, y: 2 });
    vi.advanceTimersByTime(60);
    expect(send).toHaveBeenCalledWith([
      { kind: "mouse", type: "move", x: 2, y: 2 },
    ]);
  });

  it("flushes immediately on commit", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const b = createInputBatcher(send, 60);
    b.push({ kind: "mouse", type: "down", x: 1, y: 1, button: 0 });
    b.push({ kind: "mouse", type: "up", x: 1, y: 1, button: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
