// @vitest-environment jsdom
/**
 * 浏览器直播 tab body (BrowserLivePanel) 渲染单测：
 * - 连接中 / 无直播(no_session) / 会话已结束(session_closed) / 断线重连各态文案。
 * - 逐帧换图：帧到达即 createObjectURL 换 <img src>、并 revoke 上一帧 URL（防泄漏）。
 * - 卸载回收：unmount 时 revoke 末帧 URL + stop() 收口 SSE。
 * - 活直播可交互：点过画面后可键入并攒批 POST；未点画面不抢键。无帧 / 已结束只看。
 *   无「接管 / 归还控制」。
 * mock services/browserLive 直接驱动回调；services/browserInput 仅 mock 网络（保留真坐标/批处理）；
 * 桩 URL.createObjectURL/revoke（jsdom 缺失）。块注释隔开 @vitest-environment 指令。
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/browserLive", () => ({
  startBrowserLive: vi.fn(),
}));

vi.mock("@/services/browserInput", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/browserInput")>();
  return {
    ...actual,
    sendBrowserInput: vi.fn(),
  };
});

import { sendBrowserInput } from "@/services/browserInput";
import type {
  BrowserLiveClient,
  BrowserLiveHandlers,
} from "@/services/browserLive";
import { startBrowserLive } from "@/services/browserLive";
import { BrowserLivePanel } from "../BrowserLivePanel";

const mockStart = vi.mocked(startBrowserLive);
const mockSendInput = vi.mocked(sendBrowserInput);

let captured: BrowserLiveHandlers | null;
let stopSpy: ReturnType<typeof vi.fn>;
let urlSeq: number;

beforeEach(() => {
  captured = null;
  stopSpy = vi.fn();
  urlSeq = 0;
  URL.createObjectURL = vi.fn(
    () => `blob:frame-${++urlSeq}`,
  ) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  mockStart.mockReset();
  mockStart.mockImplementation((_conversationId, handlers) => {
    captured = handlers;
    return { stop: stopSpy } satisfies BrowserLiveClient;
  });
  mockSendInput.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

/** Drive one or more live callbacks inside an act() so React flushes the update. */
function emit(fn: (h: BrowserLiveHandlers) => void): void {
  act(() => {
    if (captured) fn(captured);
  });
}

const FRAME = (frame_b64: string) => ({ frame_b64, width: 4, height: 4 });

describe("BrowserLivePanel · 状态文案", () => {
  it("attaches on mount with the conversation id and shows 连接中", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    expect(mockStart).toHaveBeenCalledWith("c1", expect.anything(), undefined);
    expect(screen.getByText("连接中…")).toBeTruthy();
  });

  it("passes sessionId to startBrowserLive when provided", () => {
    render(<BrowserLivePanel conversationId="c1" sessionId="sess-live" />);
    expect(mockStart).toHaveBeenCalledWith("c1", expect.anything(), {
      sessionId: "sess-live",
    });
  });

  it("shows the no-session state", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    emit((h) => h.onStatus("no_session"));
    expect(screen.getByText("当前没有进行中的直播")).toBeTruthy();
  });

  it("shows the reconnecting state when the transport drops", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    emit((h) => h.onConnection("reconnecting"));
    expect(screen.getByText("连接已断开，正在重连…")).toBeTruthy();
  });

  it("shows the session-closed state with no prior frame", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    emit((h) => h.onStatus("session_closed"));
    expect(screen.getByText("直播已结束")).toBeTruthy();
    expect(screen.queryByText("浏览器会话已关闭")).toBeNull();
  });
});

describe("BrowserLivePanel · 逐帧换图 + objectURL 回收", () => {
  it("renders the first frame via an object URL and marks 直播中", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    emit((h) => {
      h.onConnection("open");
      h.onStatus("started");
    });
    emit((h) => h.onFrame(FRAME("AAAA")));

    const img = screen.getByAltText("浏览器直播画面") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:frame-1");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.getByText("直播中")).toBeTruthy();
  });

  it("swaps to the newest frame and revokes the previous object URL", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    emit((h) => {
      h.onConnection("open");
      h.onStatus("started");
    });
    emit((h) => h.onFrame(FRAME("AAAA")));
    emit((h) => h.onFrame(FRAME("BBBB")));

    const img = screen.getByAltText("浏览器直播画面") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:frame-2");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    // The superseded frame's URL is revoked; the current one is not.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:frame-2");
  });

  it("keeps the last frame when the session closes, overlaying 直播已结束", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    emit((h) => {
      h.onConnection("open");
      h.onStatus("started");
      h.onFrame(FRAME("AAAA"));
    });
    emit((h) => h.onStatus("session_closed"));

    // Last frame retained (not blanked) + an ended overlay.
    expect(screen.getByAltText("浏览器直播画面")).toBeTruthy();
    expect(screen.getByText("直播已结束")).toBeTruthy();
  });

  it("revokes the last object URL and stops the client on unmount", () => {
    const { unmount } = render(<BrowserLivePanel conversationId="c1" />);
    emit((h) => {
      h.onConnection("open");
      h.onStatus("started");
      h.onFrame(FRAME("AAAA"));
    });

    unmount();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
  });
});

/** Drive the panel to a live-with-frame state (started + open + a frame). */
function goLive(): void {
  emit((h) => {
    h.onConnection("open");
    h.onStatus("started");
  });
  emit((h) => h.onFrame(FRAME("AAAA")));
}

const LIVE_SURFACE = /点击后可操作/;

describe("BrowserLivePanel · 活直播可交互 / 未点画面不抢键", () => {
  it("never offers 接管 or 归还控制, even with a live frame", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    goLive();
    expect(screen.queryByText("接管")).toBeNull();
    expect(screen.queryByText("归还控制")).toBeNull();
  });

  it("exposes an interactive surface on a live frame without auto-focus", () => {
    render(<BrowserLivePanel conversationId="c1" />);
    goLive();
    const surface = screen.getByLabelText(LIVE_SURFACE);
    expect(surface).toBeTruthy();
    expect(document.activeElement).not.toBe(surface);
    expect(screen.queryByText("接管")).toBeNull();
    expect(screen.queryByText("归还控制")).toBeNull();
  });

  it("does not capture keys until the surface is clicked", async () => {
    render(<BrowserLivePanel conversationId="c1" />);
    goLive();
    const surface = screen.getByLabelText(LIVE_SURFACE);
    await act(async () => {
      fireEvent.keyDown(surface, { key: "a", code: "KeyA" });
      fireEvent.keyUp(surface, { key: "a", code: "KeyA" });
    });
    expect(mockSendInput).not.toHaveBeenCalled();
  });

  it("captures keyboard input after the user clicks the live surface", async () => {
    render(<BrowserLivePanel conversationId="c1" sessionId="sess-live" />);
    goLive();

    const surface = screen.getByLabelText(LIVE_SURFACE);
    await act(async () => {
      fireEvent.pointerDown(surface, { clientX: 1, clientY: 1, button: 0 });
      fireEvent.keyDown(surface, { key: "a", code: "KeyA" });
      fireEvent.keyUp(surface, { key: "a", code: "KeyA" });
    });

    // keyUp is a commit event → flushes the batch (down + up) to the input endpoint.
    expect(mockSendInput).toHaveBeenCalledWith(
      "c1",
      expect.arrayContaining([
        expect.objectContaining({ kind: "key", type: "down", key: "a" }),
        expect.objectContaining({ kind: "key", type: "up", key: "a" }),
      ]),
      { sessionId: "sess-live" },
    );
  });

  it("is view-only after the session ends (last frame kept, no input)", async () => {
    render(<BrowserLivePanel conversationId="c1" />);
    goLive();
    emit((h) => h.onStatus("session_closed"));

    expect(screen.queryByLabelText(LIVE_SURFACE)).toBeNull();
    expect(screen.getByAltText("浏览器直播画面")).toBeTruthy();
    expect(screen.getByText("直播已结束")).toBeTruthy();

    const img = screen.getByAltText("浏览器直播画面");
    await act(async () => {
      fireEvent.keyDown(img, { key: "a", code: "KeyA" });
      fireEvent.keyUp(img, { key: "a", code: "KeyA" });
    });
    expect(mockSendInput).not.toHaveBeenCalled();
  });
});
